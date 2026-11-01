// The omp/pi entry (src/omp.ts) swaps a changed climb in without a restart, carrying the extension's memory.
import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

process.env.CLIMB_UPDATE_CHECK_MS = "1";

const zstub = new Proxy(() => zstub, { get: () => zstub, apply: () => zstub });
const exec = (cmd: string, args: string[], o: { cwd?: string } = {}) =>
	new Promise<{ stdout: string; stderr: string; code: number; killed: boolean }>(resolve => {
		const p = spawn(cmd, args, { cwd: o.cwd });
		let stdout = "";
		let stderr = "";
		p.stdout.on("data", d => (stdout += d));
		p.stderr.on("data", d => (stderr += d));
		p.on("close", code => resolve({ stdout, stderr, code: code ?? -1, killed: false }));
	});

describe("omp entry", () => {
	test("a changed climb swaps in on the next call, no restart, and says so once", async () => {
		const src = fs.mkdtempSync(path.join(os.tmpdir(), "climb-ompsrc-"));
		const repo = fs.mkdtempSync(path.join(os.tmpdir(), "climb-omprepo-"));
		for (const f of fs.readdirSync(path.join(import.meta.dir, "../src"))) fs.copyFileSync(path.join(import.meta.dir, "../src", f), path.join(src, f));
		await exec("bash", ["-c", "git init -q && git config user.email t@t && git config user.name t && echo 100 > work.txt && git add -A && git commit -qm init"], { cwd: repo });
		const tools = new Map<string, { execute: (...a: unknown[]) => Promise<{ content: { text: string }[] }> }>();
		const handlers = new Map<string, ((e: unknown, c: unknown) => unknown)[]>();
		const commands = new Map<string, { handler: (a: string, c: unknown) => Promise<void> }>();
		const notes: string[] = [];
		const pi = {
			zod: zstub,
			logger: { warn() {}, debug() {} },
			on: (ev: string, fn: (e: unknown, c: unknown) => unknown) => handlers.set(ev, [...(handlers.get(ev) ?? []), fn]),
			registerTool: (t: { name: string }) => tools.set(t.name, t as never),
			registerCommand: (n: string, o: never) => commands.set(n, o),
			sendMessage: () => {},
			sendUserMessage: () => {},
			exec,
		};
		const ctx = { cwd: repo, mode: "tui", agent: { kind: "main" }, sessionManager: { getSessionId: () => "s" }, isIdle: () => true, ui: { notify: (t: string) => notes.push(t), setStatus: () => {} }, setInterval: () => 1, clearTimer: () => {} };
		const status = async () => (await tools.get("climb_status")!.execute("id", {}, undefined, undefined, ctx)).content[0].text;
		try {
			const host = (await import(path.join(src, "omp.ts"))) as { default: (pi: unknown) => Promise<void> };
			await host.default(pi);
			expect(await status()).toContain("No goals. Start one");
			await commands.get("climb")!.handler("shrink work", ctx);
			// A new release lands in the source the session loaded from.
			const logic = path.join(src, "logic.ts");
			const before = fs.readFileSync(logic, "utf8");
			expect(before).toContain("Itemize the research");
			fs.writeFileSync(logic, before.replace("Itemize the research", "Itemize the research, v2"));
			const later = new Date(Date.now() + 5000);
			fs.utimesSync(logic, later, later);
			await Bun.sleep(5);
			const out = await status();
			expect(notes.some(n => n.includes("climb updated in place"))).toBe(true);
			expect(out).toContain("g-shrink-work"); // the ledger and the goal carried on
			expect(out).toContain("Itemize the research, v2"); // and the new code answers
			// Registered once with the host: no duplicate tools or handlers after the swap.
			expect(handlers.get("session_stop")).toHaveLength(1);
			await Bun.sleep(5);
			await status();
			expect(notes.filter(n => n.includes("climb updated in place"))).toHaveLength(1);
		} finally {
			fs.rmSync(src, { recursive: true, force: true });
			fs.rmSync(repo, { recursive: true, force: true });
		}
	});
});
