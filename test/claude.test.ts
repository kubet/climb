// Drives the Claude Code plugin's server over MCP stdio, the way Claude Code does, against a real git repo:
// tools/call for the climb tools, climb_hook for what hooks/hooks.json sends it.
import { describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as L from "../src/ledger";

const SERVER = path.join(import.meta.dir, "../claude/server.ts");
type Result = { content: { text: string }[]; isError?: boolean };

/** A repo with work.txt at 100, and the server started in it for `client`. `bin` goes first on PATH; no real claude is reachable. */
function setup(name: string, bin?: string, client = "claude-code") {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), `climb-claude-${name}-`));
	const sh = (c: string) => spawnSync("bash", ["-c", c], { cwd: dir, encoding: "utf8" });
	sh("git init -q && git config user.email t@t && git config user.name t && echo 100 > work.txt && git add -A && git commit -qm init");
	const PATH = [bin, ...(process.env.PATH ?? "").split(":").filter(d => !fs.existsSync(path.join(d, "claude")))].filter(Boolean).join(":");
	const p = spawn("bun", [SERVER], { cwd: dir, env: { ...process.env, PATH, CLAUDE_PROJECT_DIR: dir }, stdio: ["pipe", "pipe", "inherit"] });
	const waiting = new Map<number, (r: { result?: Result & Record<string, unknown> }) => void>();
	const progress: string[] = [];
	let buf = "";
	p.stdout.on("data", d => {
		buf += d;
		for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
			const m = JSON.parse(buf.slice(0, i));
			buf = buf.slice(i + 1);
			if (m.method === "notifications/progress") progress.push(m.params.message);
			else waiting.get(m.id)?.(m);
		}
	});
	let id = 0;
	const rpc = (method: string, params: object = {}) =>
		new Promise<{ result?: Result & Record<string, unknown> }>(resolve => {
			waiting.set(++id, resolve);
			p.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
		});
	const tool = async (name: string, args: object = {}, meta?: object) => (await rpc("tools/call", { name, arguments: args, _meta: meta })).result!;
	const text = async (name: string, args: object = {}) => (await tool(name, args)).content[0].text;
	const hook = async (args: object) => JSON.parse(await text("climb_hook", args));
	const close = () => {
		p.stdin.end();
		fs.rmSync(dir, { recursive: true, force: true });
	};
	const ready = rpc("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: client, version: "0" } });
	return { dir, sh, rpc, tool, text, hook, progress, close, ready };
}

describe("Claude Code plugin", () => {
	test("a climb through the plugin: /climb starts it, Stop is refused while it is open, the tools measure, decide and record the harness", async () => {
		const s = setup("climb");
		try {
			expect((await s.ready).result?.protocolVersion).toBe("2025-06-18"); // a revision it does not know is answered with its newest
			const listed = (await s.rpc("tools/list")).result!.tools as { name: string; inputSchema: { required: string[] } }[];
			expect(listed.map(t => t.name)).toEqual(expect.arrayContaining(["climb_scorecard", "climb_experiment", "climb_measure", "climb_status", "climb_hook"]));
			expect(listed.find(t => t.name === "climb_scorecard")!.inputSchema.required).toEqual(["metrics"]);
			// No goal: nothing holds Claude.
			expect(await s.hook({ event: "Stop" })).toEqual({});

			const started = await s.hook({ event: "UserPromptSubmit", prompt: "/climb shrink work" });
			expect(started.hookSpecificOutput.additionalContext).toContain("[climb] climb g-shrink-work started");
			expect(started.hookSpecificOutput.additionalContext).toContain("climb_probe");
			expect((L.read(s.dir)[0] as L.GoalE).harness).toBe("claude-code");
			const stop = await s.hook({ event: "Stop" });
			expect(stop.decision).toBe("block");
			expect(stop.reason).toContain("g-shrink-work");

			// The ledger, subagents and the hook channel itself are guarded before any tool runs.
			const ledger = await s.hook({ event: "PreToolUse", tool_name: "Write", file_path: path.join(s.dir, ".climb/oracle.jsonl") });
			expect(ledger.hookSpecificOutput.permissionDecision).toBe("deny");
			const sub = await s.hook({ event: "PreToolUse", tool_name: "mcp__plugin_climb_climb__climb_status", agent_id: "a1" });
			expect(sub.hookSpecificOutput.permissionDecisionReason).toContain("not subagents");
			expect((await s.hook({ event: "PreToolUse", tool_name: "mcp__plugin_climb_climb__climb_hook" })).hookSpecificOutput.permissionDecision).toBe("deny");
			// Blank substitutions (the main thread has no agent_id) pass.
			expect(await s.hook({ event: "PreToolUse", tool_name: "mcp__plugin_climb_climb__climb_status", agent_id: "", file_path: "${tool_input.file_path}" })).toEqual({});

			const card = await s.tool("climb_scorecard", { metrics: [{ name: "work", cmd: "cat work.txt", dir: "down", target: 10, noise: 0.05 }] }, { progressToken: "p1" });
			expect(card.content[0].text).toContain("work = 100");
			expect(s.progress.some(m => m.includes("work run"))).toBe(true);
			expect(await s.text("climb_experiment", { lever: "halve", hypothesis: "less work", prediction: "work -50%" })).toContain("Registered x1");
			s.sh("echo 50 > work.txt && git commit -qam halve");
			expect(await s.text("climb_measure", {})).toContain("KEPT x1");
			const card0 = L.read(s.dir).find((e): e is L.CardE => e.kind === "card")!;
			expect(card0.env?.harness).toBe("claude-code");
			const exported = JSON.parse(fs.readFileSync(path.join(s.dir, ".climb/export.json"), "utf8"));
			expect(exported.schema).toBe("climb.export/1");
			expect(exported.goals[0].harness).toBe("claude-code");
			expect(exported.metric_rows[0]).toMatchObject({ harness: "claude-code", verdict: "kept", before: 100, after: 50 });

			// A refusal comes back as a tool error, as omp shows it.
			const busy = await s.tool("climb_measure", {});
			expect(busy.isError).toBe(true);
			const paused = await s.hook({ event: "UserPromptSubmit", prompt: "/climb pause" });
			expect(paused.hookSpecificOutput.additionalContext).toContain("climb paused");
			// Claude Code knows the command as /climb:climb: a bare /climb is "Unknown command" there, and paths keep their names.
			expect(paused.hookSpecificOutput.additionalContext).toContain("/climb:climb resume to continue");
			expect(paused.hookSpecificOutput.additionalContext).not.toMatch(/(^|[^:\w])\/climb\s/);
			expect(ledger.hookSpecificOutput.permissionDecisionReason).toContain("ledger (.climb/)");
			expect((await s.hook({ event: "Stop" })).decision).toBeUndefined();
		} finally {
			s.close();
		}
	});

	test("while a measurement runs in the background, only changes to its checkout wait; reading, research and work elsewhere go on; resting is no stop", async () => {
		const s = setup("busy");
		const hold = `${s.dir}-hold`;
		try {
			await s.ready;
			await s.hook({ event: "UserPromptSubmit", prompt: "/climb shrink work" });
			await s.text("climb_scorecard", { metrics: [{ name: "work", cmd: `while [ -f ${hold} ]; do sleep 0.05; done; cat work.txt`, dir: "down", target: 10, noise: 0.05 }] });
			await s.text("climb_experiment", { lever: "halve", hypothesis: "", prediction: "" });
			s.sh("echo 50 > work.txt && git commit -qam halve");
			fs.writeFileSync(hold, "");
			const measured = s.text("climb_measure", {});
			await Bun.sleep(300);
			const edit = await s.hook({ event: "PreToolUse", tool_name: "Edit", file_path: path.join(s.dir, "work.txt") });
			expect(edit.hookSpecificOutput.permissionDecisionReason).toContain("climb is measuring");
			const free = async (h: Record<string, string>) => (await s.hook({ event: "PreToolUse", ...h })).hookSpecificOutput;
			expect(await free({ tool_name: "Read", file_path: path.join(s.dir, "work.txt") })).toBeUndefined();
			expect(await free({ tool_name: "Write", file_path: path.join(os.tmpdir(), "draft.patch") })).toBeUndefined();
			expect(await free({ tool_name: "Bash", command: "git log --oneline | head; grep -rn work . > /tmp/found.txt", cwd: s.dir })).toBeUndefined();
			for (const command of ["git commit -qam x", "echo 1 > work.txt", `sed -i '' s/5/4/ ${s.dir}/work.txt`, "cd /tmp && git -C " + s.dir + " stash"])
				expect([command, (await free({ tool_name: "Bash", command, cwd: s.dir }))?.permissionDecisionReason ?? "allowed"]).toEqual([command, expect.stringContaining("climb is measuring")]);
			expect((await s.hook({ event: "Stop" })).decision).toBeUndefined();
			fs.rmSync(hold);
			expect(await measured).toContain("KEPT x1");
			expect((await s.hook({ event: "Stop" })).decision).toBe("block");
		} finally {
			fs.rmSync(hold, { force: true });
			s.close();
		}
	});

	test("under another client (omp discovers Claude Code's plugins) the server stays empty, beside omp's own extension", async () => {
		const s = setup("omp", undefined, "omp");
		try {
			await s.ready;
			expect((await s.rpc("tools/list")).result!.tools).toEqual([]);
			expect(await s.hook({ event: "UserPromptSubmit", prompt: "/climb shrink work" })).toEqual({});
			expect(fs.existsSync(path.join(s.dir, ".climb"))).toBe(false);
		} finally {
			s.close();
		}
	});

	test("the judge is a separate headless claude -p with no tools, settings or MCP servers", async () => {
		const bin = fs.mkdtempSync(path.join(os.tmpdir(), "climb-fake-claude-"));
		const seen = path.join(bin, "seen");
		fs.writeFileSync(path.join(bin, "claude"), `#!/bin/bash\nprintf '%s\\n' "$@" > ${seen}.args\ncat > ${seen}.prompt\npwd > ${seen}.cwd\nenv > ${seen}.env\nprintf 'VERDICT: pivot\\nDIAGNOSIS: the same lever three times\\nNEXT: try caching instead\\n'\n`, { mode: 0o755 });
		const s = setup("judge", bin);
		try {
			await s.ready;
			await s.hook({ event: "UserPromptSubmit", prompt: "/climb shrink work" });
			const judged = await s.hook({ event: "UserPromptSubmit", prompt: "/climb judge" });
			expect(judged.hookSpecificOutput.additionalContext).toContain("[climb JUDGE g-shrink-work] PIVOT: the same lever three times");
			const j = L.read(s.dir).find((e): e is L.JudgeE => e.kind === "judge")!;
			expect(j).toMatchObject({ by: "judge", verdict: "pivot", next: "try caching instead" });
			const args = fs.readFileSync(`${seen}.args`, "utf8").split("\n");
			expect(args).toEqual(expect.arrayContaining(["-p", "--tools", "", "--strict-mcp-config", "--setting-sources", "--no-session-persistence"]));
			expect(fs.readFileSync(`${seen}.prompt`, "utf8")).toContain("VERDICT");
			expect(fs.realpathSync(fs.readFileSync(`${seen}.cwd`, "utf8").trim())).not.toBe(fs.realpathSync(s.dir)); // outside the repo
			// Nothing of the parent session (its id, messaging socket, effort; here its CLAUDE_PROJECT_DIR) reaches the side turn.
			expect(fs.readFileSync(`${seen}.env`, "utf8").split("\n").filter(l => /^CLAUDE/.test(l) && !l.startsWith("CLAUDE_CONFIG_DIR="))).toEqual([]);
		} finally {
			s.close();
			fs.rmSync(bin, { recursive: true, force: true });
		}
	});
});
