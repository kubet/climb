// climb's Claude Code host: the extension (src/) behind the climb tools and the hook channel.
//
// claude/server.ts owns the stdio channel and builds a host from the climb Claude Code has installed;
// when an update lands, it builds one from the new version and swaps it in while nothing measures, so a
// session takes up a new climb without a restart. A host is the session's climb, the way one omp process is:
//   - UserPromptSubmit runs /climb commands; PostToolUse and UserPromptSubmit hand Claude what the
//     extension said since (omp delivers those mid-turn)
//   - PreToolUse guards the ledger and the frozen instrument, keeps subagents off the climb tools,
//     and, while a measurement runs (Claude Code backgrounds long tool calls), refuses only changes to
//     the checkout it measures
//   - the extension says /climb (omp's and pi's command); everything a host returns says /climb:climb
//   - Stop is session_stop: Claude cannot stop while a goal is open
//   - the judge and the acceptance review are a separate headless `claude -p` with no tools
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import climb from "../src/index";

type Text = { type: "text"; text: string };
type Tool = { name: string; description: string; parameters: object; execute: (...a: unknown[]) => Promise<{ content: Text[] }> };
type Handler = (e: unknown, ctx: unknown) => unknown;
type HookOut = Record<string, unknown>;
/** What the plugin's hooks pass to climb_hook (hooks/hooks.json): strings from the hook's input. */
type HookIn = { event: string; prompt?: string; tool_name?: string; file_path?: string; notebook_path?: string; command?: string; agent_id?: string; cwd?: string };

const HOOK = "climb_hook";
// Claude Code's file tools by the names the extension's guards know (omp's).
const NAMES: Record<string, string> = { Bash: "bash", Write: "write", Edit: "edit", MultiEdit: "edit", NotebookEdit: "notebook" };
// A stdio tool call that says nothing for 30 minutes is aborted by Claude Code; one benchmark run can take longer.
const KEEPALIVE_MS = 60_000;
const SIDE_TURN_MS = 5 * 60_000;

// --- the host the extension expects -------------------------------------------------------

// The extension builds tool schemas through TypeBox's API (its upstream-pi path). TypeBox schemas are
// JSON Schema, which is what MCP lists; optional properties are left out of `required`.
const OPT = Symbol("optional");
type Schema = Record<string | symbol, unknown>;
const Type = {
	Object: (properties: Record<string, Schema>) => ({ type: "object", properties, required: Object.keys(properties).filter(k => !properties[k][OPT]) }),
	String: (o?: object) => ({ type: "string", ...o }),
	Number: (o?: object) => ({ type: "number", ...o }),
	Boolean: (o?: object) => ({ type: "boolean", ...o }),
	Array: (items: Schema, o?: object) => ({ type: "array", items, ...o }),
	Literal: (value: string) => ({ const: value }),
	Union: (xs: { const: string }[], o?: object) => ({ type: "string", enum: xs.map(x => x.const), ...o }),
	Optional: (s: Schema) => ({ ...s, [OPT]: true }),
};

/** pi.exec. The command runs as its own process group, so a timeout or an interrupt also stops what it started. */
function exec(cmd: string, args: string[], o: { cwd?: string; timeout?: number; signal?: AbortSignal; input?: string; env?: NodeJS.ProcessEnv } = {}) {
	return new Promise<{ stdout: string; stderr: string; code: number; killed: boolean }>(resolve => {
		const p = spawn(cmd, args, { cwd: o.cwd, env: o.env, detached: true, stdio: [o.input === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		let killed = false;
		let done = false;
		const signal = (s: NodeJS.Signals) => {
			try {
				process.kill(-p.pid!, s);
			} catch {}
		};
		const kill = () => {
			if (done || killed) return;
			killed = true;
			signal("SIGTERM");
			setTimeout(() => !done && signal("SIGKILL"), 3000).unref();
		};
		const timer = o.timeout ? setTimeout(kill, o.timeout) : undefined;
		o.signal?.addEventListener("abort", kill, { once: true });
		if (o.signal?.aborted) kill();
		p.stdout!.on("data", d => (stdout += d));
		p.stderr!.on("data", d => (stderr += d));
		if (o.input !== undefined) p.stdin!.end(o.input);
		const finish = (code: number) => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			o.signal?.removeEventListener("abort", kill);
			resolve({ stdout, stderr, code, killed });
		};
		p.on("error", e => {
			stderr += String(e);
			finish(127);
		});
		p.on("close", code => finish(code ?? -1));
	});
}

const claudeBin = Bun.which("claude");
/** The judge's and the acceptance review's side turn: a separate headless Claude outside the repo, with no
 *  tools, settings, plugins or MCP servers, so it sees only the prompt the extension built. */
async function sideTurn(o: { promptText: string }): Promise<{ replyText: string }> {
	// Only the account's config travels. The parent session's id, messaging socket and effort are its own: an inherited
	// CLAUDE_EFFORT=xhigh kept a real acceptance review thinking past its 5 minutes.
	const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("CLAUDE") || k === "CLAUDE_CONFIG_DIR"));
	const args = ["-p", "--tools", "", "--strict-mcp-config", "--setting-sources", "", "--no-session-persistence", "--output-format", "text"];
	const r = await exec(claudeBin!, args, { cwd: os.tmpdir(), env, input: o.promptText, timeout: SIDE_TURN_MS });
	if (r.code !== 0 || !r.stdout.trim()) throw new Error(`claude -p ${r.killed ? "timed out" : `exit ${r.code}`}: ${(r.stderr || r.stdout).trim().slice(-200)}`);
	return { replyText: r.stdout.trim() };
}

/** Claude Code names the plugin's command /climb:climb; a bare /climb is "Unknown command" there. */
const named = (s: string) => s.replace(/(^|[^\w:/.~-])\/climb(?![\w:/-])/g, "$1/climb:climb");
const rename = (v: unknown): unknown =>
	typeof v === "string" ? named(v) : Array.isArray(v) ? v.map(rename) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, rename(x)])) : v;
/** This host's climb version (its package.json). */
export const VERSION: string = (() => {
	try {
		return JSON.parse(fs.readFileSync(path.join(import.meta.dir, "..", "package.json"), "utf8")).version;
	} catch {
		return "?";
	}
})();

/** What a host hands its successor: what the extension said that Claude has not taken in yet. */
export interface Carry {
	outbox: string[];
	notes: string[];
	wake: boolean;
	idle: boolean;
	/** The extension's memory (measurement cache, the session's goals, judges running): the same object, passed on. */
	keep?: Record<string, unknown>;
}
export interface Host {
	version: string;
	/** The climb tools and the hook channel, for tools/list. */
	list(): object[];
	call(id: string | number, p: { name: string; arguments?: Record<string, unknown>; _meta?: { progressToken?: string | number } }): Promise<object>;
	cancel(id: string | number): void;
	/** Tool calls running now: a host is swapped only when none is. */
	busy(): number;
	handoff(): Carry;
	stop(): Promise<void>;
}

/** The session's climb. `send` writes a notification to Claude Code; `carry` is the previous host's, after an update. */
export async function createHost(io: { send: (msg: object) => void }, carry?: Carry, from?: string): Promise<Host> {
	const send = (msg: object) => io.send(rename(msg) as object);
	const tools = new Map<string, Tool>();
	const handlers = new Map<string, Handler[]>();
	const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
	/** What the extension says to the worker; Claude takes it in at the next hook. */
	const outbox: string[] = [];
	/** Something in the outbox asks for a turn (omp's triggerTurn): a Stop is refused to deliver it. */
	let wake = false;
	/** ui.notify: for the person. */
	const notes: string[] = [];
	let idle = true;
	/** Climb tool calls running now: Claude Code moves long ones to the background and carries on. */
	let measuring = 0;
	/** The worker was told to keep working through the measurement running now. */
	let nudged = false;

	const pi = {
		harness: "claude-code",
		keep: carry?.keep ?? {},
		typebox: { Type },
		logger: { warn: (msg: string, o?: object) => console.error(msg, o ?? ""), debug() {} },
		on: (ev: string, fn: Handler) => handlers.set(ev, [...(handlers.get(ev) ?? []), fn]),
		registerTool: (t: Tool) => tools.set(t.name, t),
		registerCommand: (name: string, c: { handler: (args: string, ctx: unknown) => Promise<void> }) => commands.set(name, c),
		sendMessage: (m: { content: string }, o?: { triggerTurn?: boolean }) => {
			outbox.push(m.content);
			wake ||= !!o?.triggerTurn;
		},
		sendUserMessage: (text: string) => {
			outbox.push(text);
			wake = true;
		},
		exec,
	};
	const ctx = {
		cwd: process.env.CLAUDE_PROJECT_DIR || process.cwd(),
		mode: "tui", // a command never waits for a turn to start: Claude Code starts it
		agent: { kind: "main" },
		isIdle: () => idle,
		ui: { notify: (text: string) => notes.push(text), setStatus() {} },
		runEphemeralTurn: claudeBin ? sideTurn : undefined,
	};

	async function emit(ev: string, e: object, c: object = ctx): Promise<{ decision?: string; reason?: string; block?: boolean; context?: string[] } | undefined> {
		let out: unknown;
		for (const fn of handlers.get(ev) ?? []) out = (await fn({ type: ev, ...e }, c)) ?? out;
		return out as never;
	}

	// --- hooks ---------------------------------------------------------------------------------

	/** Hook strings are substituted from the hook's input; a field the event lacks may come through blank. */
	const given = (s?: string) => (s && !s.startsWith("${") ? s : undefined);
	/** This server's tools as Claude Code names them: mcp__plugin_climb_climb__climb_measure. */
	const ours = (name: string) => name.startsWith("mcp__") && (tools.has(name.split("__").pop()!) || name.endsWith(`__${HOOK}`));
	const deny = (reason: string): HookOut => ({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } });
	/** What the extension said since the last hook, for Claude; with `told`, its notices too (a /climb command's answer). */
	function said(told = false): string {
		const text = [...outbox.splice(0), ...(told ? notes.splice(0).map(n => `[climb] ${n}`) : [])].join("\n\n");
		wake = false;
		return text;
	}
	const context = (event: string, text: string): HookOut => (text ? { hookSpecificOutput: { hookEventName: event, additionalContext: text } } : {});
	const toPerson = (): HookOut => (notes.length ? { systemMessage: notes.splice(0).join("\n") } : {});

	async function hook(a: HookIn): Promise<HookOut> {
		const sub = !!given(a.agent_id);
		switch (a.event) {
			case "UserPromptSubmit": {
				idle = false;
				const m = /^\s*\/(?:climb:)?climb(?:\s+([\s\S]*))?$/.exec(a.prompt ?? "");
				if (m) await commands.get("climb")!.handler((m[1] ?? "").trim(), ctx);
				return context("UserPromptSubmit", said(!!m));
			}
			case "PreToolUse": {
				const name = a.tool_name ?? "";
				if (ours(name) && name.endsWith(`__${HOOK}`)) return deny(`${HOOK} is the climb plugin's own hook channel, not a tool to call.`);
				if (ours(name) && sub) return deny("climb tools belong to the main worker, not subagents. Report back to it instead.");
				const input = Object.fromEntries(Object.entries({ file_path: a.file_path, notebook_path: a.notebook_path, command: a.command, cwd: a.cwd }).filter(([, v]) => given(v)));
				const r = await emit("tool_call", { toolName: NAMES[name] ?? name.toLowerCase(), input }, { ...ctx, agent: { kind: sub ? "sub" : "main" } });
				return r?.block ? deny(r.reason ?? "blocked by climb") : {};
			}
			case "PostToolUse":
				if (sub) return {};
				idle = false;
				return context("PostToolUse", said());
			case "Stop": {
				// A climb tool still running in the background wakes Claude when it settles. Until then the worker is not
				// done: voice's sat idle through every measurement. Asked once per measurement; then it may rest.
				if (measuring) {
					if (nudged) return toPerson();
					nudged = true;
					return {
						decision: "block",
						reason: "[climb] A measurement is running in the background; its result wakes you. Until then keep working: research the next lever, write its proof, draft the change in a scratch file (only changes to the measured checkout wait for the result).",
						...toPerson(),
					};
				}
				const r = await emit("session_stop", {});
				const asks = wake;
				const text = said();
				if (r?.decision === "block") return { decision: "block", reason: [text, r.reason].filter(Boolean).join("\n\n"), ...toPerson() };
				if (text && asks) return { decision: "block", reason: text, ...toPerson() };
				idle = true;
				return toPerson();
			}
			case "SessionStart": {
				// After a compaction or /clear the worker has lost the climb from its context: hand it the state again.
				const r = await emit("session.compacting", {});
				return context("SessionStart", [r?.context?.join("\n"), said()].filter(Boolean).join("\n\n"));
			}
		}
		return {};
	}

	const live = new Map<string | number, AbortController>();

	async function call(id: string | number, p: { name: string; arguments?: Record<string, unknown>; _meta?: { progressToken?: string | number } }) {
		// Renamed before it is serialized: "\n/climb" inside JSON text reads as "n/climb".
		if (p.name === HOOK) return { content: [{ type: "text", text: JSON.stringify(rename(await hook((p.arguments ?? {}) as HookIn))) }] };
		const tool = tools.get(p.name);
		if (!tool) return { content: [{ type: "text", text: `Unknown tool ${p.name}.` }], isError: true };
		const ac = new AbortController();
		live.set(id, ac);
		const token = p._meta?.progressToken;
		let n = 0;
		let last = "";
		const progress = (message: string) => token !== undefined && send({ method: "notifications/progress", params: { progressToken: token, progress: ++n, message } });
		const keepalive = setInterval(() => progress(last || `${p.name} running`), KEEPALIVE_MS);
		measuring++;
		idle = false;
		try {
			const r = await tool.execute(String(id), p.arguments ?? {}, ac.signal, (u: { content: Text[] }) => progress((last = u.content.map(c => c.text).join(""))), ctx);
			return { content: r.content.map(c => ({ type: "text", text: c.text })) };
		} catch (e) {
			// A refusal is the climb doing its job (a coin-toss metric, a dirty tree), not a crash: Claude Code shows an
			// error result as "MCP task failed", which read as the plugin breaking. It says what is not done and why.
			return { content: [{ type: "text", text: `Not done: ${e instanceof Error ? e.message : String(e)}` }] };
		} finally {
			clearInterval(keepalive);
			measuring--;
			if (!measuring) nudged = false;
			live.delete(id);
		}
	}

	await climb(pi as never);
	if (carry) {
		outbox.push(...carry.outbox);
		notes.push(...carry.notes);
		wake = carry.wake;
		idle = carry.idle;
	}
	if (from) notes.push(`climb ${from} → ${VERSION}: the update is live in this session, no restart.`);
	await emit("session_start", {});
	return {
		version: VERSION,
		list: () => [
			...[...tools.values()].map(t => ({ name: t.name, description: named(t.description), inputSchema: rename(t.parameters) })),
			{ name: HOOK, description: "The climb plugin's hooks call this; it is not a tool for you.", inputSchema: { type: "object", properties: { event: { type: "string" } } } },
		],
		call: async (id, p) => rename(await call(id, p)) as object,
		cancel: id => live.get(id)?.abort(),
		busy: () => measuring,
		handoff: () => ({ outbox: outbox.splice(0), notes: notes.splice(0), wake, idle, keep: pi.keep }),
		stop: async () => {
			await emit("session_shutdown", {});
		},
	};
}
