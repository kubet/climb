// climb for Claude Code: the extension the omp/pi hosts load (src/), hosted by an MCP stdio server.
//
// Claude Code starts this server once per session. Its tools are the climb tools, and the plugin's
// hooks call its climb_hook tool, so one extension instance holds the session's state (lease,
// measurement lock, judge, stop counters) the way one omp process does:
//   - UserPromptSubmit runs /climb commands; PostToolUse and UserPromptSubmit hand Claude what the
//     extension said since (omp delivers those mid-turn)
//   - PreToolUse guards the ledger and the frozen instrument, keeps subagents off the climb tools,
//     and, while a measurement runs (Claude Code backgrounds long tool calls), refuses only changes to
//     the checkout it measures
//   - the extension says /climb (omp's and pi's command); everything this server sends says /climb:climb
//   - Stop is session_stop: Claude cannot stop while a goal is open
//   - the judge and the acceptance review are a separate headless `claude -p` with no tools
import { spawn } from "node:child_process";
import * as os from "node:os";
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

const pi = {
	harness: "claude-code",
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
			// A climb tool still running in the background wakes Claude when it settles: resting until then is no stop.
			if (measuring) return toPerson();
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

// --- MCP over stdio ---------------------------------------------------------------------------

/** Claude Code names the plugin's command /climb:climb; a bare /climb is "Unknown command" there. */
const named = (s: string) => s.replace(/(^|[^\w:/.~-])\/climb(?![\w:/-])/g, "$1/climb:climb");
const rename = (v: unknown): unknown =>
	typeof v === "string" ? named(v) : Array.isArray(v) ? v.map(rename) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, rename(x)])) : v;
const send = (msg: object) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...(rename(msg) as object) })}\n`);
const live = new Map<string | number, AbortController>();

async function call(id: string | number, p: { name: string; arguments?: Record<string, unknown>; _meta?: { progressToken?: string | number } }) {
	if (p.name === HOOK) return { content: [{ type: "text", text: JSON.stringify(await hook((p.arguments ?? {}) as HookIn)) }] };
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
		return { content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }], isError: true };
	} finally {
		clearInterval(keepalive);
		measuring--;
		live.delete(id);
	}
}

const VERSIONS = ["2024-11-05", "2025-03-26", "2025-06-18"];
async function dispatch(m: { id?: string | number; method?: string; params?: Record<string, unknown> }) {
	try {
		switch (m.method) {
			case "initialize": {
				// omp also discovers plugins installed in Claude Code: under any other client this server stays
				// empty, or two climbs (omp's extension and this one) would drive one ledger.
				if ((m.params?.clientInfo as { name?: string } | undefined)?.name === "claude-code") ready ??= start();
				const asked = m.params?.protocolVersion as string;
				return send({ id: m.id, result: { protocolVersion: VERSIONS.includes(asked) ? asked : VERSIONS.at(-1), capabilities: { tools: {} }, serverInfo: { name: "climb", version: "0.3.3" } } });
			}
			case "ping":
				return send({ id: m.id, result: {} });
			case "tools/list": {
				if (!ready) return send({ id: m.id, result: { tools: [] } });
				await ready;
				const list = [...tools.values()].map(t => ({ name: t.name, description: t.description, inputSchema: t.parameters }));
				list.push({ name: HOOK, description: "The climb plugin's hooks call this; it is not a tool for you.", inputSchema: { type: "object", properties: { event: { type: "string" } } } });
				return send({ id: m.id, result: { tools: list } });
			}
			case "tools/call":
				if (!ready) return send({ id: m.id, result: { content: [{ type: "text", text: "{}" }] } });
				await ready;
				return send({ id: m.id, result: await call(m.id!, m.params as never) });
			case "notifications/cancelled":
				return live.get(m.params?.requestId as string)?.abort();
		}
		if (m.id !== undefined && m.method) send({ id: m.id, error: { code: -32601, message: `Method not found: ${m.method}` } });
	} catch (e) {
		if (m.id !== undefined) send({ id: m.id, error: { code: -32603, message: String(e) } });
	}
}

/** The climb, loaded once Claude Code has said who it is. */
let ready: Promise<void> | undefined;
async function start() {
	await climb(pi as never);
	await emit("session_start", {});
}

let buf = "";
process.stdin.on("data", d => {
	buf += d;
	for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
		const line = buf.slice(0, i).trim();
		buf = buf.slice(i + 1);
		if (!line) continue;
		try {
			void dispatch(JSON.parse(line));
		} catch {
			send({ id: null, error: { code: -32700, message: "Parse error" } });
		}
	}
});
process.stdin.on("end", () => process.exit(0));
