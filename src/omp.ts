// climb for omp and pi: the entry they load once. It runs the climb (index.ts and its modules) and forwards every
// tool, command and event to it. When the climb's source changes (an update, a new release in a linked checkout),
// the next event while no climb tool runs loads a fresh copy and swaps it in, the extension's memory carried over:
// the session takes up the new climb without a restart. omp loads an extension once, so every release used to
// show "↻ restart omp to update climb" again, right after the user had restarted for the last one.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import climb from "./index";

// biome-ignore lint/suspicious/noExplicitAny: the host's API, passed through whole
type Any = any;
type Fn = (...a: Any[]) => Any;
interface Climb {
	tools: Map<string, Any>;
	handlers: Map<string, Fn[]>;
	commands: Map<string, Any>;
}

const here = import.meta.dir;
/** The newest source file's change time: what a swap compares. */
const stamp = () => {
	try {
		return Math.max(...fs.readdirSync(here).filter(f => f.endsWith(".ts")).map(f => fs.statSync(path.join(here, f)).mtimeMs));
	} catch {
		return 0;
	}
};
const CHECK_MS = Number(process.env.CLIMB_UPDATE_CHECK_MS) || 10_000;

export default async function climbHost(pi: Any): Promise<void> {
	/** The extension's memory (measurement cache, the session's goals, judges running), handed to every version. */
	const keep: Record<string, unknown> = {};
	const registered = { tools: new Set<string>(), events: new Set<string>(), commands: new Set<string>() };
	let current: Climb = { tools: new Map(), handlers: new Map(), commands: new Map() };
	let loaded = stamp();
	let running = 0;
	let checked = Date.now();
	let lastCtx: Any;
	let swapping: Promise<void> | undefined;

	const dispatch = async (inner: Climb, ev: string, e: Any, ctx: Any) => {
		let out: unknown;
		for (const fn of inner.handlers.get(ev) ?? []) out = (await fn(e, ctx)) ?? out;
		return out;
	};

	/** The pi the climb sees: the host's own, except that what it registers lands in `inner`. */
	const view = (inner: Climb) =>
		new Proxy(pi, {
			get(t, k) {
				if (k === "keep") return keep;
				if (k === "hot") return true;
				if (k === "on")
					return (ev: string, fn: Fn) => {
						inner.handlers.set(ev, [...(inner.handlers.get(ev) ?? []), fn]);
						if (registered.events.has(ev)) return;
						registered.events.add(ev);
						pi.on(ev, async (e: Any, ctx: Any) => {
							if (ctx && ctx.agent?.kind !== "sub") lastCtx = ctx;
							if (ev !== "session_shutdown") await update();
							return dispatch(current, ev, e, ctx);
						});
					};
				if (k === "registerTool")
					return (tool: Any) => {
						inner.tools.set(tool.name, tool);
						if (registered.tools.has(tool.name)) return;
						registered.tools.add(tool.name);
						pi.registerTool({
							...tool,
							execute: async (...a: Any[]) => {
								await update();
								running++;
								try {
									return await (current.tools.get(tool.name) ?? tool).execute(...a);
								} finally {
									running--;
								}
							},
						});
					};
				if (k === "registerCommand")
					return (name: string, c: Any) => {
						inner.commands.set(name, c);
						if (registered.commands.has(name)) return;
						registered.commands.add(name);
						pi.registerCommand(name, {
							...c,
							handler: async (args: string, ctx: Any) => {
								lastCtx = ctx;
								await update();
								return (current.commands.get(name) ?? c).handler(args, ctx);
							},
						});
					};
				const v = Reflect.get(t, k);
				return typeof v === "function" ? v.bind(t) : v;
			},
			has: (t, k) => k === "keep" || k === "hot" || Reflect.has(t, k),
		});

	/** A newer source swaps in between climb tool calls; one that fails to load leaves the running climb as it is. */
	function update(): Promise<void> | undefined {
		if (swapping || running || Date.now() - checked < CHECK_MS) return swapping;
		checked = Date.now();
		const now = stamp();
		if (now <= loaded + 1000) return undefined;
		swapping = (async () => {
			try {
				// A fresh copy of the source: the module cache keeps the paths it has loaded, so a new path is a new climb.
				const dir = fs.mkdtempSync(path.join(os.tmpdir(), "climb-hot-"));
				for (const f of fs.readdirSync(here)) if (f.endsWith(".ts")) fs.copyFileSync(path.join(here, f), path.join(dir, f));
				const mod = (await import(path.join(dir, "index.ts"))) as { default: (pi: Any) => Promise<void> };
				const next: Climb = { tools: new Map(), handlers: new Map(), commands: new Map() };
				await mod.default(view(next));
				const old = current;
				await dispatch(old, "session_shutdown", { type: "session_shutdown" }, lastCtx);
				current = next;
				loaded = now;
				if (lastCtx) await dispatch(next, "session_start", { type: "session_start" }, lastCtx);
				lastCtx?.ui?.notify?.("climb updated in place: the newest climb runs in this session, no restart.", "info");
			} catch (e) {
				pi.logger?.warn?.("climb: the update failed to load; the running climb stays", { error: String(e) });
				checked = Date.now() + 10 * 60_000;
			} finally {
				swapping = undefined;
			}
		})();
		return swapping;
	}

	await climb(view(current));
}
