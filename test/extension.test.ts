// Drives the real extension through a fake host against a real git repo.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import climb, { DERIVED, disk, ENVS, leaksIntoRepo } from "../src/index";
import * as L from "../src/ledger";
import * as X from "../src/logic";
import * as T from "../src/trace";

type Handler = (e: unknown, ctx: unknown) => unknown;

function exec(cmd: string, args: string[], opts: { cwd?: string; timeout?: number }) {
	return new Promise<{ stdout: string; stderr: string; code: number; killed: boolean }>(resolve => {
		const p = spawn(cmd, args, { cwd: opts.cwd });
		let stdout = "";
		let stderr = "";
		let killed = false;
		const t = opts.timeout ? setTimeout(() => ((killed = true), p.kill()), opts.timeout) : undefined;
		p.stdout.on("data", d => (stdout += d));
		p.stderr.on("data", d => (stderr += d));
		p.on("close", code => {
			if (t) clearTimeout(t);
			resolve({ stdout, stderr, code: code ?? -1, killed });
		});
	});
}

// Any property/call chain works: z.object({...}).describe("x").optional()
const zstub: unknown = new Proxy(() => zstub, { get: () => zstub, apply: () => zstub });

function host(cwd: string, kind: "main" | "sub" = "main", sid = "s1") {
	const handlers = new Map<string, Handler[]>();
	const tools = new Map<string, { execute: (...a: unknown[]) => Promise<{ content: { text: string }[] }> }>();
	const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
	const sent: { m: { content: string }; o?: { triggerTurn?: boolean; deliverAs?: string } }[] = [];
	const user: string[] = [];
	const notes: string[] = [];
	const h = {
		idle: true,
		judge: "VERDICT: pivot\nDIAGNOSIS: same idea repeated\nNEXT: try a different algorithm",
		judgeThrows: false,
		/** Replies for the next side turns, in order; then judge. */
		replies: [] as string[],
		timerFn: undefined as undefined | (() => void),
	};
	const pi = {
		zod: zstub,
		logger: { warn() {}, debug() {} },
		on: (ev: string, fn: Handler) => handlers.set(ev, [...(handlers.get(ev) ?? []), fn]),
		registerTool: (t: { name: string }) => tools.set(t.name, t as never),
		registerCommand: (n: string, o: never) => commands.set(n, o),
		sendMessage: (m: never, o: never) => sent.push({ m, o }),
		sendUserMessage: (t: string) => user.push(t),
		exec,
	};
	const ctx = {
		cwd,
		mode: "tui",
		agent: { kind },
		sessionManager: { getSessionId: () => sid },
		isIdle: () => h.idle,
		ui: { notify: (t: string) => notes.push(t), setStatus: () => {} },
		runEphemeralTurn: () => {
			if (h.judgeThrows) throw new Error("side turn refused synchronously");
			return Promise.resolve({ replyText: h.replies?.shift() ?? h.judge });
		},
		setInterval: (fn: () => void) => ((h.timerFn = fn), 1),
		clearTimer: () => {},
	};
	return {
		h,
		sent,
		user,
		notes,
		load: () => climb(pi as never),
		tool: async (name: string, params: object) => (await tools.get(name)!.execute("id", params, undefined, undefined, ctx)).content[0].text,
		noJudge: () => {
			delete (ctx as { runEphemeralTurn?: unknown }).runEphemeralTurn;
		},
		toolWith: async (name: string, params: object, signal: AbortSignal) => (await tools.get(name)!.execute("id", params, signal, undefined, ctx)).content[0].text,
		cmd: (args: string) => commands.get("climb")!.handler(args, ctx),
		emit: async (ev: string, e: object = {}) => {
			let out: unknown;
			for (const fn of handlers.get(ev) ?? []) out = (await fn({ type: ev, ...e }, ctx)) ?? out;
			return out as { decision?: string; reason?: string; block?: boolean } | undefined;
		},
	};
}

let dir: string;
const sh = (cmd: string) => exec("bash", ["-c", cmd], { cwd: dir });
const commit = (value: number, msg: string) => sh(`echo ${value} > work.txt && git add -A && git commit -q --allow-empty -m "${msg}"`);
const ledger = () => L.read(dir);
const state = () => L.fold(ledger());
const until = async (pred: () => boolean, ms = 5000) => {
	const end = Date.now() + ms;
	while (!pred()) {
		if (Date.now() > end) throw new Error("timed out waiting");
		await Bun.sleep(20);
	}
};

beforeAll(async () => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "climb-"));
	await sh("git init -q && git config user.email t@t && git config user.name t && echo 100 > work.txt && git add -A && git commit -qm init");
});
afterAll(() => (process.env.KEEP ? console.log("KEPT", dir) : fs.rmSync(dir, { recursive: true, force: true })));

describe("climb extension", () => {
	let x: ReturnType<typeof host>;
	const scorecard = {
		metrics: [{ name: "work", cmd: "cat work.txt", dir: "down", target: 10, unit: "units", noise: 0.05 }],
		guard: "test -s work.txt",
	};

	test("/climb starts a goal, excludes the ledger from git, briefs the worker", async () => {
		x = host(dir);
		await x.load();
		await x.emit("session_start");
		await x.cmd("shrink the work number --beat 30m --poke-max 2");
		const g = [...state().goals.values()][0];
		expect(g.id).toBe("g-shrink-the-work-number");
		expect(g.cfg).toEqual({ beat_s: 1800, poke_max: 2 });
		expect(x.user[0]).toContain("climb_scorecard");
		expect(fs.readFileSync(path.join(dir, ".git/info/exclude"), "utf8")).toContain(".climb/");
		expect((await sh("git status --porcelain")).stdout.trim()).toBe("");
		expect(x.h.timerFn).toBeDefined();
	});

	test("stop is blocked while the goal is open", async () => {
		const r = await x.emit("session_stop");
		expect(r?.decision).toBe("block");
		expect(r?.reason).toContain("Researching");
	});

	test("research is itemized: probes are run by the extension and listed", async () => {
		expect(await x.tool("climb_probe", { name: "work_units", cmd: "cat work.txt", note: "the thing to shrink" })).toContain("work_units = 100 (research item 1)");
		expect(await x.tool("climb_probe", { name: "broken", cmd: "exit 3" })).toContain("failed");
		const g = state().goals.get("g-shrink-the-work-number")!;
		expect(g.probes.map(p => [p.name, p.value])).toEqual([["work_units", 100], ["broken", undefined]]);
		expect(L.progressSinceBeat(g)).toBe(true);
		expect(await x.tool("climb_status", {})).toContain("work_units = 100");
	});

	test("scorecard: extension measures the baseline; rejects dirty trees, broken commands, met targets", async () => {
		await sh("echo junk > scratch.txt && echo 99 > work.txt");
		await expect(x.tool("climb_scorecard", scorecard)).rejects.toThrow("dirty");
		await sh("git checkout work.txt"); // untracked scratch.txt stays: junk is not dirt
		await expect(x.tool("climb_scorecard", { metrics: [{ name: "w", cmd: "echo none", dir: "down", target: 1 }] })).rejects.toThrow("no number");
		await expect(x.tool("climb_scorecard", { metrics: [{ name: "w", cmd: "cat work.txt", dir: "down", target: 500 }] })).rejects.toThrow("already meets");
		const four = Array.from({ length: 4 }, (_, i) => ({ name: `m${i}`, cmd: "echo 1", dir: "up", target: 9 }));
		await expect(x.tool("climb_scorecard", { metrics: four })).rejects.toThrow("1-3 metrics");
		const out = await x.tool("climb_scorecard", scorecard);
		expect(out).toContain("work = 100");
		expect(state().goals.get("g-shrink-the-work-number")!.card!.metrics[0].baseline).toBe(100);
	});

	test("experiment → commit → measure: kept on real gain", async () => {
		const reg = await x.tool("climb_experiment", { lever: "halve", hypothesis: "less work", prediction: "work -50%" });
		expect(reg).toContain("Control at");
		await expect(x.tool("climb_experiment", { lever: "other", hypothesis: "", prediction: "" })).rejects.toThrow("still open");
		await expect(x.tool("climb_measure", {})).rejects.toThrow("still the base commit");
		await commit(50, "halve");
		const out = await x.tool("climb_measure", {});
		expect(out).toContain("KEPT x1");
		expect(state().goals.get("g-shrink-the-work-number")!.best.work).toBe(50);
	});

	test("regression is dropped and reverted by the extension", async () => {
		await x.tool("climb_experiment", { lever: "bloat", hypothesis: "?", prediction: "?" });
		await commit(80, "bloat");
		const out = await x.tool("climb_measure", {});
		expect(out).toContain("DROPPED x2");
		expect(out).toContain("Reverted");
		expect(fs.readFileSync(path.join(dir, "work.txt"), "utf8").trim()).toBe("50");
		expect((await sh("git log -1 --format=%s")).stdout).toContain("revert: climb x2");
	});

	test("a guard failure decides nothing: the experiment stays open for the fix, and stray files are named", async () => {
		await x.tool("climb_experiment", { lever: "empty", hypothesis: "?", prediction: "?" });
		await sh("mkdir -p scratch && echo draft > scratch/notes.txt && : > work.txt && git commit -qam empty");
		const results = () => ledger().filter(e => e.kind === "result").length;
		const before = results();
		const refused = x.tool("climb_measure", {});
		await expect(refused).rejects.toThrow("stays open");
		await expect(refused).rejects.toThrow("scratch/");
		expect(results()).toBe(before);
		expect(fs.readFileSync(path.join(dir, "work.txt"), "utf8")).toBe("");
		await sh("rm -r scratch && echo 50 > work.txt && git commit -qam fix");
		expect(await x.tool("climb_measure", {})).toContain("no metric beat noise");
		expect(fs.readFileSync(path.join(dir, "work.txt"), "utf8").trim()).toBe("50");
	});

	test("the worker cannot touch the ledger or git clean it away", async () => {
		expect((await x.emit("tool_call", { toolName: "write", input: { path: ".climb/oracle.jsonl", content: "" } }))?.block).toBe(true);
		expect((await x.emit("tool_call", { toolName: "bash", input: { command: "rm -rf .climb" } }))?.block).toBe(true);
		expect((await x.emit("tool_call", { toolName: "bash", input: { command: "git clean -fdx" } }))?.block).toBe(true);
		expect(await x.emit("tool_call", { toolName: "bash", input: { command: "tail .climb/oracle.jsonl" } })).toBeUndefined();
		expect(await x.emit("tool_call", { toolName: "write", input: { path: "src/a.ts" } })).toBeUndefined();
		// Writes into the ledger are refused; reads that redirect elsewhere and files that only mention it are not
		// (a Claude Code session was refused its own `2>/dev/null`, and omp refused edits of tests that name the ledger).
		for (const command of ["echo x > .climb/oracle.jsonl", "echo x >> ./.climb/trace.jsonl", "printf x | tee -a .climb/oracle.jsonl", "mv .climb /tmp/gone", "sed -i s/a/b/ .climb/oracle.jsonl", "cd .climb && echo > oracle.jsonl", 'echo x > "$PWD/.climb/oracle.jsonl"'])
			expect((await x.emit("tool_call", { toolName: "bash", input: { command } }))?.block).toBe(true);
		for (const command of ["tail -n 3 .climb/oracle.jsonl 2>/dev/null | cut -c1-200", "cat .climb/lease.json > /tmp/lease.json", "cp src/a.ts src/b.ts && grep kept .climb/oracle.jsonl", "ls -la .climb/ 2>&1 | head"])
			expect(await x.emit("tool_call", { toolName: "bash", input: { command } })).toBeUndefined();
		expect((await x.emit("tool_call", { toolName: "edit", input: { path: `${dir}/.climb/oracle.jsonl` } }))?.block).toBe(true);
		expect(await x.emit("tool_call", { toolName: "edit", input: { path: "test/a.test.ts", newText: "tail .climb/oracle.jsonl > /tmp/x" } })).toBeUndefined();
	});

	test("heartbeat: skips while busy, watchdog at 2x, drives work when idle; poke_max stale beats summon the judge", async () => {
		const goal = "g-shrink-the-work-number";
		const t0 = Date.now();
		const beats = () => ledger().filter((e): e is L.BeatE => e.kind === "beat" && e.goal === goal);
		const fire = async (min: number, idle: boolean) => {
			L.clock.ms = () => t0 + min * 60_000 + (Date.now() - t0);
			x.h.idle = idle;
			x.h.timerFn!();
			await Bun.sleep(300);
		};

		await fire(45, false);
		expect(beats()).toHaveLength(0); // busy and under 2x the interval: leave it alone

		await fire(61, false);
		expect(beats()).toHaveLength(1); // watchdog beat
		expect(beats()[0]).toMatchObject({ progress: true, stale: 0 }); // x1 was kept since the goal started
		expect(x.sent).toHaveLength(0); // progress while busy: nothing to say

		await fire(122, false);
		expect(beats()[1]).toMatchObject({ progress: false, stale: 1, note: "worker busy" }); // never measures mid-edit
		expect(x.sent.at(-1)).toMatchObject({ o: { deliverAs: "aside" } }); // check in without derailing
		expect(x.sent.at(-1)!.m.content).toContain("no progress (stale 1/2)");

		await fire(153, true);
		expect(beats()[2].stale).toBe(2);
		expect(ledger().some(e => e.kind === "stall")).toBe(true);
		const j = ledger().find((e): e is L.JudgeE => e.kind === "judge")!;
		expect(j).toMatchObject({ by: "judge", verdict: "pivot", next: "try a different algorithm" });
		expect(x.sent.at(-1)).toMatchObject({ o: { triggerTurn: true } });
		expect(x.sent.at(-1)!.m.content).toContain("[climb JUDGE");

		await fire(184, true);
		expect(beats()[3].stale).toBe(1); // the judge reset the count: no judge on every beat
		expect(ledger().filter(e => e.kind === "judge")).toHaveLength(1);
		expect(x.sent.at(-1)!.m.content).toContain("[climb heartbeat");
		expect(x.sent.at(-1)!.o?.triggerTurn).toBe(true);
	});

	test("three drops in a row block experiments until diagnosis; renaming the lever does not dodge it", async () => {
		const judged = ledger().filter(e => e.kind === "judge" && e.by === "judge").length;
		let last = "";
		for (const lever of ["bloat", "bloat v2", "padding"]) {
			await x.tool("climb_experiment", { lever, hypothesis: "?", prediction: "?" });
			await commit(90, lever);
			last = await x.tool("climb_measure", {});
			expect(last).toContain("DROPPED");
		}
		// The drop that trips the gate summons the independent judge at once (self-grading never clears it: ledger tests).
		expect(last).toContain("3 experiments dropped in a row: that is grid search. The independent judge is reviewing now");
		await until(() => ledger().filter(e => e.kind === "judge" && e.by === "judge").length > judged);
		expect(await x.tool("climb_experiment", { lever: "noop", hypothesis: "?", prediction: "?" })).toContain("Registered");
		await commit(50, "noop");
		expect(await x.tool("climb_measure", {})).toContain("DROPPED");
	});

	test("one session drives the climb; another takes over only when the driver goes silent", async () => {
		const other = host(dir, "main", "s2");
		await other.load();
		process.env.CLIMB_LEASE_ID = "other-process";
		await expect(other.tool("climb_experiment", { lever: "x", hypothesis: "", prediction: "" })).rejects.toThrow("Another omp/pi session");
		expect(await other.emit("session_stop")).toBeUndefined();
		const t = L.clock.ms();
		L.clock.ms = () => t + 61_000 + (Date.now() - t);
		expect(await other.tool("climb_status", {})).toContain("climbing");
		await other.cmd("resume");
		delete process.env.CLIMB_LEASE_ID;
		await expect(x.tool("climb_experiment", { lever: "x", hypothesis: "", prediction: "" })).rejects.toThrow("Another omp/pi session");
		await x.cmd("resume"); // take it back explicitly
		process.env.CLIMB_LEASE_ID = "other-process";
		await expect(other.tool("climb_experiment", { lever: "x", hypothesis: "", prediction: "" })).rejects.toThrow("Another omp/pi session");
		// Nor does a new goal take a live driver's checkout: it is told to climb in its own checkout.
		const goals = state().goals.size;
		await other.cmd("make it faster too");
		expect(other.notes.at(-1)).toContain("Another live session is climbing this checkout");
		expect(state().goals.size).toBe(goals);
		delete process.env.CLIMB_LEASE_ID;
	});

	test("stop-hook valve: a worker that stops twice without working gets the judge, not a nap", async () => {
		const judged = () => ledger().filter(e => e.kind === "judge" && e.by === "judge").length;
		const before = judged();
		expect((await x.emit("session_stop"))?.decision).toBe("block");
		expect((await x.emit("session_stop"))?.decision).toBe("block");
		expect(await x.emit("session_stop")).toBeUndefined();
		await until(() => judged() > before);
		expect(x.sent.at(-1)!.m.content).toContain("[climb JUDGE");
		expect((await x.emit("session_stop"))?.decision).toBe("block");
	});

	test("judge 'stuck' releases the stop hook; progress resumes the climb", async () => {
		x.h.judge = "VERDICT: stuck\nDIAGNOSIS: needs a human\nNEXT: ask";
		await x.cmd("judge");
		await until(() => (ledger().filter(e => e.kind === "judge").at(-1) as L.JudgeE).verdict === "stuck");
		expect(await x.emit("session_stop")).toBeUndefined();
		expect(x.notes.some(n => n.includes("STUCK"))).toBe(true);
		await x.tool("climb_experiment", { lever: "delete", hypothesis: "less", prediction: "-60%" });
		await commit(20, "delete");
		expect(await x.tool("climb_measure", {})).toContain("KEPT");
		expect((await x.emit("session_stop"))?.decision).toBe("block");
	});

	test("hitting every target closes the goal and releases the worker", async () => {
		await x.tool("climb_experiment", { lever: "delete", hypothesis: "less", prediction: "-60%" });
		await commit(5, "delete more");
		const out = await x.tool("climb_measure", {});
		expect(out).toContain("GOAL ACHIEVED");
		expect([...state().goals.values()][0].done?.result).toBe("achieved");
		expect(await x.emit("session_stop")).toBeUndefined();
		const status = await x.tool("climb_status", {});
		expect(status).toContain("DONE (achieved)");
		expect(status).toMatch(/experiments: \d+ \(\d+ kept/);
	});

	test("frozen instrument: scripts the metric runs cannot change inside an experiment", async () => {
		await sh(`printf 'cat work.txt\n' > bench.sh && git add -A && git commit -qm bench`);
		await x.cmd("halve work again --beat 30m");
		const card = await x.tool("climb_scorecard", { goal: "g-halve-work-again", metrics: [{ name: "w", cmd: "bash bench.sh", dir: "down", target: 1 }] });
		expect(card).toContain("Frozen instrument: bench.sh");
		await x.tool("climb_experiment", { goal: "g-halve-work-again", lever: "fudge", hypothesis: "", prediction: "" });
		const blocked = await x.emit("tool_call", { toolName: "edit", input: { path: path.join(dir, "bench.sh") } });
		expect(blocked?.block).toBe(true);
		await sh(`printf 'echo 1\n' > bench.sh && git commit -qam fudge`);
		const out = await x.tool("climb_measure", { goal: "g-halve-work-again" });
		expect(out).toContain("DROPPED");
		expect(out).toContain("instrument changed (bench.sh)");
		expect(fs.readFileSync(path.join(dir, "bench.sh"), "utf8")).toBe("cat work.txt\n");
	});

	test("measuring never leaves the tree dirty: tracked artifacts are restored, untracked junk ignored", async () => {
		await sh("echo 0 > stamp.txt && git add stamp.txt && git commit -qm stamp");
		await x.cmd("count work with side effects");
		const goal = "g-count-work-with-side";
		const card = await x.tool("climb_scorecard", {
			goal,
			metrics: [{ name: "w2", cmd: "date +%s%N > stamp.txt; mkdir -p cache && date > cache/junk; cat work.txt", dir: "down", target: 1 }],
		});
		expect(card).toContain("restored");
		expect((await sh("git status --porcelain --untracked-files=no")).stdout.trim()).toBe("");
		await x.tool("climb_experiment", { goal, lever: "trim", hypothesis: "", prediction: "" });
		await commit(3, "trim");
		expect(await x.tool("climb_measure", { goal })).toContain("KEPT");
		expect((await sh("git status --porcelain --untracked-files=no")).stdout.trim()).toBe("");
	});

	test("subagents cannot drive the climb and never start a heartbeat", async () => {
		const sub = host(dir, "sub");
		await sub.load();
		await sub.emit("session_start");
		expect(sub.h.timerFn).toBeUndefined();
		await expect(sub.tool("climb_experiment", { lever: "a", hypothesis: "", prediction: "" })).rejects.toThrow("main worker");
		expect(await sub.emit("session_stop")).toBeUndefined();
	});

	test("external tracking: every ledger event reaches an http webhook or a command sink", async () => {
		const got: { text: string; entry: L.Entry }[] = [];
		const server = Bun.serve({ port: 0, fetch: async req => (got.push(await req.json()), new Response("ok")) });
		try {
			process.env.CLIMB_SINK = `http://localhost:${server.port}/hook`;
			await x.cmd("pause");
			await until(() => got.length > 0);
			expect(got[0]).toMatchObject({ text: "[climb] paused", entry: { kind: "pause" } });

			const log = path.join(dir, "..", `sink-${path.basename(dir)}.log`);
			process.env.CLIMB_SINK = `cat >> ${log}`;
			await x.cmd("resume");
			await until(() => fs.existsSync(log) && fs.readFileSync(log, "utf8").includes("resumed"));
			const line = JSON.parse(fs.readFileSync(log, "utf8").trim().split("\n").at(-1)!);
			expect(line).toMatchObject({ text: "[climb] resumed", repo: path.basename(dir), entry: { kind: "resume" } });
			fs.rmSync(log, { force: true });
		} finally {
			delete process.env.CLIMB_SINK;
			server.stop(true);
		}
	});
});

describe("reviewer regressions", () => {
	let rdir: string;
	let y: ReturnType<typeof host>;
	const rsh = (cmd: string) => exec("bash", ["-c", cmd], { cwd: rdir });
	const card = { metrics: [{ name: "w", cmd: "cat work.txt", dir: "down", target: 1, noise: 0.05 }] };

	beforeAll(async () => {
		rdir = fs.mkdtempSync(path.join(os.tmpdir(), "climb-r-"));
		await rsh("git init -q && git config user.email t@t && git config user.name t && echo 100 > work.txt && git add -A && git commit -qm init");
		y = host(rdir, "main", "r1");
		await y.load();
		await y.cmd("shrink work");
	});
	afterAll(() => fs.rmSync(rdir, { recursive: true, force: true }));

	test("an untracked instrument script is rejected before it can be reverted away", async () => {
		await rsh("printf 'cat work.txt\\n' > bench.sh");
		await expect(y.tool("climb_scorecard", { metrics: [{ name: "w", cmd: "bash bench.sh", dir: "down", target: 1 }] })).rejects.toThrow("Commit the instrument first");
		await rsh("rm bench.sh");
		expect(await y.tool("climb_scorecard", card)).toContain("w = 100");
	});

	test("bun test / go test do not freeze the test directory", () => {
		const t = new Set(["test/a.test.ts", "src/x.ts"]);
		expect(X.instrumentFiles("bun test", t)).toEqual([]);
		expect(X.instrumentFiles("go test ./...", t)).toEqual([]);
		expect(X.instrumentFiles("bun test test/", t)).toEqual(["test/"]);
	});

	test("an interrupted measurement decides nothing and keeps the experiment open", async () => {
		await y.tool("climb_experiment", { lever: "halve", hypothesis: "", prediction: "" });
		await rsh("echo 50 > work.txt && git commit -qam halve");
		const ac = new AbortController();
		ac.abort();
		const quick = await y.toolWith("climb_measure", {}, ac.signal).catch((e: Error) => e.message);
		expect(quick).toContain("interrupted");
		expect(quick).not.toContain("cut off"); // a person's interrupt, not a caller's timeout
		expect(L.fold(L.read(rdir)).goals.get("g-shrink-work")!.open?.id).toBe("x1");
		expect(await y.tool("climb_measure", {})).toContain("KEPT x1");
	});

	test("a measurement cut off after an hour says a caller's timeout stopped it and to call the tool directly", async () => {
		await y.tool("climb_experiment", { lever: "halve again", hypothesis: "", prediction: "" });
		await rsh("echo 25 > work.txt && git commit -qam halve");
		const ac = new AbortController();
		ac.abort();
		const real = L.clock.ms;
		const t = real();
		let first = true;
		L.clock.ms = () => (first ? ((first = false), t) : t + 60 * 60_000);
		try {
			await expect(y.toolWith("climb_measure", {}, ac.signal)).rejects.toThrow("cut off after 60 min: if eval or a script called it");
		} finally {
			L.clock.ms = real;
		}
		expect(await y.tool("climb_measure", { abandon: "test over" })).toContain("DROPPED x2"); // later tests climb from 50
	});

	test("commits climb never measured cannot become the baseline", async () => {
		await rsh("echo 400 > work.txt && git commit -qam sneaky");
		await expect(y.tool("climb_experiment", { lever: "x", hypothesis: "", prediction: "" })).rejects.toThrow("regressed w 50→400");
		await rsh("git revert --no-edit HEAD >/dev/null");
		expect(await y.tool("climb_experiment", { lever: "x", hypothesis: "", prediction: "" })).toContain("Control at");
	});

	test("a revert blocked by a commit hook is reported and halts climbing instead of poisoning the baseline", async () => {
		await rsh("printf '#!/bin/sh\\ngrep -q \"^feat\" \"$1\"\\n' > .git/hooks/commit-msg && chmod +x .git/hooks/commit-msg");
		await rsh("echo 90 > work.txt && git commit -qam 'feat: bloat'");
		const out = await y.tool("climb_measure", {});
		expect(out).toContain("auto-revert failed");
		expect((await rsh("git status --porcelain --untracked-files=no")).stdout.trim()).toBe("");
		await expect(y.tool("climb_experiment", { lever: "y", hypothesis: "", prediction: "" })).rejects.toThrow("regressed");
		await rsh("rm .git/hooks/commit-msg && git revert --no-edit HEAD >/dev/null");
		expect(await y.tool("climb_experiment", { lever: "y", hypothesis: "", prediction: "" })).toContain("Control at");
	});

	test("harmless commits outside an experiment are adopted, not fought", async () => {
		await rsh("git commit -q --allow-empty -m y");
		await y.tool("climb_measure", {}); // close the experiment the previous test opened
		await rsh("echo notes > NOTES.md && git add NOTES.md && git commit -qm notes");
		const out = await y.tool("climb_experiment", { lever: "z", hypothesis: "", prediction: "" });
		expect(out).toContain("Adopted commits");
		await rsh("echo 45 > work.txt && git commit -qam z");
		expect(await y.tool("climb_measure", {})).toContain("KEPT");
	});

	test("/climb resume is the human's verdict that un-sticks a goal", async () => {
		y.h.judge = "VERDICT: stuck\nDIAGNOSIS: needs a human\nNEXT: ask";
		await y.cmd("judge");
		await until(() => (L.read(rdir).filter(e => e.kind === "judge").at(-1) as L.JudgeE | undefined)?.verdict === "stuck");
		expect(await y.emit("session_stop")).toBeUndefined();
		await y.cmd("resume");
		expect(L.read(rdir).filter(e => e.kind === "judge").at(-1)).toMatchObject({ by: "human", verdict: "continue" });
		expect((await y.emit("session_stop"))?.decision).toBe("block");
	});
});

describe("hosts without an independent judge", () => {
	test("the worker's own diagnosis clears the gate instead of deadlocking it", async () => {
		const d = fs.mkdtempSync(path.join(os.tmpdir(), "climb-nj-"));
		const run = (c: string) => exec("bash", ["-c", c], { cwd: d });
		try {
			await run("git init -q && git config user.email t@t && git config user.name t && echo 100 > work.txt && git add -A && git commit -qm init");
			const z = host(d, "main", "nj");
			z.noJudge();
			await z.load();
			await z.cmd("shrink");
			await z.tool("climb_scorecard", { metrics: [{ name: "w", cmd: "cat work.txt", dir: "down", target: 1, noise: 0.05 }] });
			for (const v of [120, 130, 140]) {
				await z.tool("climb_experiment", { lever: `l${v}`, hypothesis: "", prediction: "" });
				await run(`echo ${v} > work.txt && git commit -qam l${v}`);
				expect(await z.tool("climb_measure", {})).toContain("DROPPED");
			}
			await expect(z.tool("climb_experiment", { lever: "next", hypothesis: "", prediction: "" })).rejects.toThrow("No independent judge");
			await z.tool("climb_judge", { verdict: "pivot", diagnosis: "adding work never helps", next: "remove work" });
			expect(L.read(d).filter(e => e.kind === "judge").at(-1)).toMatchObject({ by: "fallback" });
			expect(await z.tool("climb_experiment", { lever: "next", hypothesis: "", prediction: "" })).toContain("Registered");
		} finally {
			fs.rmSync(d, { recursive: true, force: true });
		}
	});
});

describe("hold metrics", () => {
	test("a constraint like 'no slower' needs no target, blocks regressions, and does not block achievement", async () => {
		const d = fs.mkdtempSync(path.join(os.tmpdir(), "climb-hold-"));
		const run = (c: string) => exec("bash", ["-c", c], { cwd: d });
		try {
			await run("git init -q && git config user.email t@t && git config user.name t && echo 100 > mem.txt && echo 50 > ms.txt && git add -A && git commit -qm init");
			const z = host(d, "main", "hold");
			await z.load();
			await z.cmd("halve memory, no slower");
			await expect(z.tool("climb_scorecard", { metrics: [{ name: "ms", cmd: "cat ms.txt", dir: "down", hold: true }] })).rejects.toThrow("must have a target");
			const card = await z.tool("climb_scorecard", {
				metrics: [
					{ name: "mem", cmd: "cat mem.txt", dir: "down", target: 50, noise: 0.05 },
					{ name: "ms", cmd: "cat ms.txt", dir: "down", hold: true, noise: 0.05 },
				],
			});
			expect(card).toContain("ms = 50 → hold (must not regress)");
			await z.tool("climb_experiment", { lever: "trade speed for memory", hypothesis: "", prediction: "" });
			await run("echo 40 > mem.txt && echo 70 > ms.txt && git commit -qam slower");
			expect(await z.tool("climb_measure", {})).toContain("regressed: ms 50→70");
			await z.tool("climb_experiment", { lever: "smaller structures", hypothesis: "", prediction: "" });
			await run("echo 45 > mem.txt && git commit -qam smaller");
			expect(await z.tool("climb_measure", {})).toContain("GOAL ACHIEVED");
		} finally {
			fs.rmSync(d, { recursive: true, force: true });
		}
	});
});

// Fumbles seen in a 5-hour live climb (voice agent, real omp), each pinned here.
describe("lessons from a live run", () => {
	let d: string;
	let z: ReturnType<typeof host>;
	const run = (c: string) => exec("bash", ["-c", c], { cwd: d });
	// A metric whose runs are counted in .git/ (outside the tree) so tests can see what was re-measured.
	const counted = (file: string) => `n=$(cat .git/runs 2>/dev/null || echo 0); echo $((n+1)) > .git/runs; cat ${file}`;
	const runsSoFar = async () => Number((await run("cat .git/runs 2>/dev/null || echo 0")).stdout.trim());
	const realMs = L.clock.ms;

	beforeAll(async () => {
		d = fs.mkdtempSync(path.join(os.tmpdir(), "climb-live-"));
		await run("git init -q && git config user.email t@t && git config user.name t && echo 100 > work.txt && echo 50 > ms.txt && git add -A && git commit -qm init");
		z = host(d, "main", "live");
		await z.load();
		await z.cmd("shrink work");
	});
	afterAll(() => {
		L.clock.ms = realMs;
		fs.rmSync(d, { recursive: true, force: true });
	});

	test("a probe gets its own timeout and says when it hit it", async () => {
		expect(await z.tool("climb_probe", { name: "slow", cmd: "sleep 3; echo 1", timeout_s: 1 })).toContain("timed out after 1s");
		expect(await z.tool("climb_probe", { name: "work_left", cmd: "cat work.txt" })).toContain("= 100");
	});

	test("noise shrinks with samples; a metric that cannot resolve its target is refused, and the retry reuses runs", async () => {
		// Runs cycle 100, 160, 40: a ±60% spread per run.
		const noisy = "n=$(cat .git/cyc 2>/dev/null || echo 0); echo $((n+1)) > .git/cyc; awk -v n=$n 'BEGIN{split(\"100 160 40\",a,\" \"); print a[n%3+1]}'";
		const err = await z.tool("climb_scorecard", { metrics: [{ name: "lat", cmd: noisy, dir: "down", target: 1 }] }).catch(e => String(e));
		expect(err).toContain("as large as the whole way to the target");
		expect(err).toContain("Samples: 5");
		const card = await z.tool("climb_scorecard", { metrics: [{ name: "lat", cmd: noisy, dir: "down", target: 1, samples: 5 }] });
		expect(Number((await run("cat .git/cyc")).stdout.trim())).toBe(5); // 3 cached + 2 topped up, not 3 + 5
		expect(card).toContain("each kept step must beat");
		expect(X.noiseOf([100, 160, 40], 100, 9)).toBeLessThan(X.noiseOf([100, 160, 40], 100, 1) / 2);
	});

	test("a tree measured minutes ago is not re-measured for the control; a stale one is", async () => {
		await z.tool("climb_scorecard", { metrics: [{ name: "work", cmd: counted("work.txt"), dir: "down", target: 10, noise: 0.05 }] });
		const before = await runsSoFar();
		expect(await z.tool("climb_experiment", { lever: "noop", hypothesis: "", prediction: "" })).toContain("reused runs of this tree");
		expect(await runsSoFar()).toBe(before);
		await run("echo 100 > other.txt && git add other.txt && git commit -qm noop");
		expect(await z.tool("climb_measure", {})).toContain("DROPPED x1");
		const measured = await runsSoFar();
		expect(measured).toBe(before + 1); // the candidate is always measured fresh
		// The revert restored the base tree: its control runs are reused.
		expect(await z.tool("climb_experiment", { lever: "noop again", hypothesis: "", prediction: "" })).toContain("reused runs");
		expect(await runsSoFar()).toBe(measured);
		await run("echo 101 > other.txt && git add other.txt && git commit -qm noop2");
		await z.tool("climb_measure", {});
		const clock = L.clock.ms; // earlier suites may have moved it
		L.clock.ms = () => clock() + 31 * 60_000;
		expect(await z.tool("climb_experiment", { lever: "later", hypothesis: "", prediction: "" })).not.toContain("reused");
		expect(await runsSoFar()).toBe(measured + 2);
		await run("echo 50 > work.txt && git commit -qam halve");
		expect(await z.tool("climb_measure", {})).toContain("KEPT x3");
		L.clock.ms = clock;
	});

	test("a probe named in the prediction cannot decide; a proof can, and keeps a real fix the scorecard cannot see", async () => {
		await expect(z.tool("climb_experiment", { lever: "fix", hypothesis: "", prediction: "work_left stays, bug fixed" })).rejects.toThrow("work_left, a probe");
		await expect(z.tool("climb_experiment", { lever: "fix", hypothesis: "", prediction: "", proof: "true" })).rejects.toThrow("must fail before the change");
		await expect(z.tool("climb_experiment", { lever: "fix", hypothesis: "", prediction: "", proof: "bash checks/fixed.sh" })).rejects.toThrow("does not exist yet");
		await run("mkdir -p checks && printf 'test \"$(cat fixed.txt 2>/dev/null)\" = yes\\n' > checks/fixed.sh");
		const reg = await z.tool("climb_experiment", { lever: "fix", hypothesis: "the bug", prediction: "work_left unchanged; fixed", proof: "bash checks/fixed.sh" });
		expect(reg).toContain("The proof fails here");
		expect(reg).not.toContain("git-ignored");
		// Its runtime is kept: at measurement a run far longer than at registration has hung.
		expect((L.read(d).filter(e => e.kind === "exp").at(-1) as L.ExpE).proof?.ms).toBeGreaterThanOrEqual(0);
		expect((await z.emit("tool_call", { toolName: "write", input: { path: path.join(d, "checks/fixed.sh"), content: "true" } }))?.block).toBe(true);
		await run("echo yes > fixed.txt && git add fixed.txt && git commit -qm fix");
		const out = await z.tool("climb_measure", {});
		expect(out).toContain("KEPT x4 by proof");
		const entries = L.read(d);
		const g = L.fold(entries).goals.get("g-shrink-work")!;
		expect(entries.at(-1)).toMatchObject({ kind: "result", verdict: "kept", proof: true });
		expect(g.streak).toBe(0);
		// A proven fix is kept, but only x3's measured gain counts as progress for the heartbeat.
		expect(g.lastKeptSeq).toBe(entries.findIndex(e => e.kind === "result" && e.exp === "x3"));
		expect(g.best.work).toBe(50);
	});

	test("an edited proof proves nothing, and the experiment is dropped", async () => {
		await run("printf 'test \"$(cat fixed2.txt 2>/dev/null)\" = yes\\n' > checks/fixed2.sh");
		await z.tool("climb_experiment", { lever: "fix2", hypothesis: "", prediction: "", proof: "bash checks/fixed2.sh" });
		await run("echo true > checks/fixed2.sh && echo x > fixed2.txt && git add -A && git commit -qm cheat");
		const out = await z.tool("climb_measure", {});
		expect(out).toContain("DROPPED x5");
		expect(out).toContain("proof void: checks/fixed2.sh changed");
	});

	test("a proof only adds keeps: a measured gain stands while the claimed fix is incomplete", async () => {
		await run("mkdir -p checks && printf 'test \"$(cat fixed3.txt 2>/dev/null)\" = yes\\n' > checks/fixed3.sh");
		await z.tool("climb_experiment", { lever: "fix3", hypothesis: "", prediction: "", proof: "bash checks/fixed3.sh" });
		await run("echo 25 > work.txt && git commit -qam faster-but-unfixed");
		const out = await z.tool("climb_measure", {});
		expect(out).toContain("KEPT x6");
		expect(out).toContain("the claimed fix is not complete yet");
		await z.tool("climb_experiment", { lever: "fix3", hypothesis: "", prediction: "", proof: "bash checks/fixed3.sh" });
		await run("echo 20 > work.txt && echo yes > fixed3.txt && git add -A && git commit -qm faster-and-fixed");
		expect(await z.tool("climb_measure", {})).toMatch(/KEPT x7: work 25→20 .*; proof passes/);
	});

	test("a hold metric bouncing back is not a gain; one flaky run is retried", async () => {
		// The hold metric's first-ever run fails: the retry absorbs it.
		const flaky = "test -f .git/warm || { touch .git/warm; exit 1; }; cat ms.txt";
		await z.tool("climb_scorecard", {
			metrics: [
				{ name: "work", cmd: "cat work.txt", dir: "down", target: 10, noise: 0.05 },
				{ name: "ms", cmd: flaky, dir: "down", hold: true, noise: 0.05 },
			],
		});
		await z.tool("climb_experiment", { lever: "speed only", hypothesis: "", prediction: "" });
		await run("echo 40 > ms.txt && git commit -qam faster");
		expect(await z.tool("climb_measure", {})).toContain("no metric beat noise");
	});

	test("a worst value that repeats exactly (a cap or penalty) is named instead of advising more samples", async () => {
		const cmd = "n=$(cat .git/capn 2>/dev/null || echo 0); echo $((n+1)) > .git/capn; [ $n -eq 2 ] && echo 28252.5 || echo 75000";
		const err = z.tool("climb_scorecard", { metrics: [{ name: "p90", cmd, dir: "down", target: 1500, noise: 0.1 }] });
		await expect(err).rejects.toThrow("75000 repeats exactly as the worst value");
		await expect(err).rejects.not.toThrow("Samples:");
		await run("rm -f .git/capn");
	});

	test("instrument outside the repo is flagged", async () => {
		const ext = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "climb-ext-")), "bench.sh");
		fs.writeFileSync(ext, "echo 100\n");
		const out = await z.tool("climb_scorecard", { metrics: [{ name: "work", cmd: `bash ${ext}`, dir: "down", target: 10 }] });
		expect(out).toContain("Instrument outside the repo");
		expect(out).toContain("in a temp directory, cleared on reboot");
		fs.rmSync(path.dirname(ext), { recursive: true, force: true });
	});
});

// Seen in the same climb's 16-hour overnight run and its restart.
describe("lessons from the night", () => {
	let d: string;
	let z: ReturnType<typeof host>;
	const run = (c: string) => exec("bash", ["-c", c], { cwd: d });
	const last = (kind: string) => L.read(d).filter(e => e.kind === kind).at(-1);

	beforeAll(async () => {
		d = fs.mkdtempSync(path.join(os.tmpdir(), "climb-night-"));
		await run("git init -q && git config user.email t@t && git config user.name t && echo 100 > work.txt && git add -A && git commit -qm init");
		// A restart: the lease still names a process on this machine that has exited.
		fs.mkdirSync(path.join(d, ".climb"));
		fs.writeFileSync(path.join(d, ".climb/lease.json"), JSON.stringify({ who: `${os.hostname()}:999999`, ts: L.clock.ms() }));
		z = host(d, "main", "night");
		await z.load();
		await z.cmd("shrink work");
	});
	afterAll(() => fs.rmSync(d, { recursive: true, force: true }));

	test("a restarted session takes over from its own dead process at once", async () => {
		fs.writeFileSync(path.join(d, ".climb/lease.json"), JSON.stringify({ who: `${os.hostname()}:999999`, ts: L.clock.ms() }));
		expect(await z.tool("climb_probe", { name: "w", cmd: "cat work.txt" })).toContain("= 100");
		fs.writeFileSync(path.join(d, ".climb/lease.json"), JSON.stringify({ who: `${os.hostname()}:${process.ppid}`, ts: L.clock.ms() }));
		await expect(z.tool("climb_probe", { name: "w", cmd: "cat work.txt" })).rejects.toThrow("Another omp/pi session");
		fs.rmSync(path.join(d, ".climb/lease.json"));
	});

	test("only the independent judge releases a stall, and a stall left without one gets one", async () => {
		await z.tool("climb_scorecard", { metrics: [{ name: "work", cmd: "test ! -f .git/broken && cat work.txt", dir: "down", target: 10, noise: 0.05 }] });
		// As if the process died between the stall and the judge's verdict.
		L.append(d, { ts: L.now(), kind: "stall", goal: "g-shrink-work", stale: 3 });
		await z.tool("climb_judge", { verdict: "pivot", diagnosis: "I think it is fine", next: "carry on" });
		expect(L.fold(L.read(d)).goals.get("g-shrink-work")!.stallPending).toBe(true);
		await expect(z.tool("climb_experiment", { lever: "a", hypothesis: "", prediction: "" })).rejects.toThrow("independent judge is reviewing");
		await until(() => (last("judge") as L.JudgeE | undefined)?.by === "judge");
		expect(await z.tool("climb_experiment", { lever: "a", hypothesis: "", prediction: "" })).toContain("Registered x1");
	});

	test("a crashed measurement decides nothing; abandon drops and reverts", async () => {
		await run("echo 50 > work.txt && git commit -qam halve && touch .git/broken");
		await expect(z.tool("climb_measure", {})).rejects.toThrow("x1 stays open");
		expect(last("result")).toBeUndefined();
		await run("rm .git/broken");
		expect(await z.tool("climb_measure", {})).toContain("KEPT x1");
		await z.tool("climb_experiment", { lever: "b", hypothesis: "", prediction: "" });
		await run("echo 40 > work.txt && git commit -qam b");
		expect(await z.tool("climb_measure", { abandon: "grader is down" })).toContain("DROPPED x2 (abandoned: grader is down). Reverted");
		expect(fs.readFileSync(path.join(d, "work.txt"), "utf8").trim()).toBe("50");
		expect(last("result")).toMatchObject({ exp: "x2", verdict: "dropped" });
	});

	test("a broken metric fails the scorecard after one run of each; good runs survive for the retry", async () => {
		const count = async (f: string) => Number((await run(`cat .git/${f} 2>/dev/null || echo 0`)).stdout.trim());
		const a = "n=$(cat .git/a 2>/dev/null || echo 0); echo $((n+1)) > .git/a; cat work.txt";
		await expect(z.tool("climb_scorecard", { metrics: [{ name: "work", cmd: a, dir: "down", target: 10 }, { name: "bad", cmd: "exit 1", dir: "down", target: 1 }] })).rejects.toThrow("Fix these metric commands");
		expect(await count("a")).toBe(1);
		// Runs 3 and 4 crash (the retry too): runs 1-2 are kept, so the retry needs one more.
		const c = "n=$(cat .git/c 2>/dev/null || echo 0); echo $((n+1)) > .git/c; test $n -ne 2 && test $n -ne 3 && cat work.txt";
		await expect(z.tool("climb_scorecard", { metrics: [{ name: "work", cmd: c, dir: "down", target: 10 }] })).rejects.toThrow("exit 1");
		expect(await count("c")).toBe(4);
		expect(await z.tool("climb_scorecard", { metrics: [{ name: "work", cmd: c, dir: "down", target: 10 }] })).toContain("work = 50");
		expect(await count("c")).toBe(5);
	});
});

// Found by an independent review of the two live-run commits.
describe("review findings", () => {
	let d: string;
	let z: ReturnType<typeof host>;
	const run = (c: string) => exec("bash", ["-c", c], { cwd: d });
	const last = (kind: string) => L.read(d).filter(e => e.kind === kind).at(-1);

	beforeAll(async () => {
		d = fs.mkdtempSync(path.join(os.tmpdir(), "climb-review-"));
		await run("git init -q && git config user.email t@t && git config user.name t && echo 100 > work.txt && mkdir checks && echo 'exit 0' > checks/base.sh && git add -A && git commit -qm init");
		z = host(d, "main", "review");
		await z.load();
	});
	afterAll(() => fs.rmSync(d, { recursive: true, force: true }));

	test("opening omp in a repo without a climb writes nothing into it", async () => {
		await z.emit("session_start");
		expect(fs.existsSync(path.join(d, ".climb"))).toBe(false);
	});

	test("a committed failing test can be the proof, though the guard suite runs it", async () => {
		await z.cmd("shrink work");
		await z.tool("climb_scorecard", { metrics: [{ name: "work", cmd: "cat work.txt", dir: "down", target: 10, noise: 0.05 }], guard: "for f in checks/*.sh; do bash $f || exit 1; done" });
		await run("printf 'test -f fixed.txt\\n' > checks/fixed.sh && git add checks && git commit -qm 'failing check'");
		expect(await z.tool("climb_experiment", { lever: "fix", hypothesis: "", prediction: "", proof: "bash checks/fixed.sh" })).toContain("Registered x1");
		await run("touch fixed.txt && git add fixed.txt && git commit -qm fix");
		expect(await z.tool("climb_measure", {})).toContain("KEPT x1 by proof");
	});

	test("commits that break the guard are refused before any control is measured", async () => {
		const runs = () => T.read(d).filter(t => t.kind === "run" && t.phase === "control").length;
		const before = runs();
		await run("printf 'exit 1\\n' > checks/broken.sh && git add checks && git commit -qm 'broken check'");
		await expect(z.tool("climb_experiment", { lever: "anything", hypothesis: "", prediction: "" })).rejects.toThrow("pass it as proof");
		expect(runs()).toBe(before);
		await run("git rm -q checks/broken.sh && git commit -qm 'drop broken check'");
	});

	test("a proof that cannot run at measure decides nothing", async () => {
		// Outside checks/, so the guard suite does not run it.
		await run("mkdir -p extra && printf 'test -f fixed2.txt || exit 1\\nmissing-tool-xyz\\n' > extra/two.sh");
		await z.tool("climb_experiment", { lever: "fix2", hypothesis: "", prediction: "", proof: "bash extra/two.sh" });
		await run("touch fixed2.txt && git add fixed2.txt && git commit -qm fix2");
		await expect(z.tool("climb_measure", { abandon: null })).rejects.toThrow("x2 stays open"); // null is not abandon
		await expect(z.tool("climb_measure", { goal: "", abandon: "" })).rejects.toThrow("x2 stays open"); // nor is "" (strict-schema providers send it)
		expect(last("result")).toMatchObject({ exp: "x1" });
		await z.tool("climb_measure", { abandon: "check needs a tool this machine lacks" });
	});

	test("a proof kept in a git-ignored path is accepted with a warning", async () => {
		await run("mkdir -p runs && echo 'runs/' >> .git/info/exclude && printf 'test -f fixed9.txt\\n' > runs/check.sh");
		expect(await z.tool("climb_experiment", { lever: "f9", hypothesis: "", prediction: "", proof: "bash runs/check.sh" })).toContain("runs/check.sh is git-ignored");
		await z.tool("climb_measure", { abandon: "warning checked" });
	});

	test("a proof must name the file a self-discovering runner would run", async () => {
		await expect(z.tool("climb_experiment", { lever: "f", hypothesis: "", prediction: "", proof: "bun test -t handoff" })).rejects.toThrow("Name the check's file");
		expect(X.scriptPaths("pytest tests/t.py::test_x && curl https://x.io/a.json --out build/out.txt")).toEqual(["tests/t.py"]);
	});

	test("a paused climb stays asleep across a restart, even with a stall pending", async () => {
		L.append(d, { ts: L.now(), kind: "stall", goal: "g-shrink-work", stale: 3 }, { ts: L.now(), kind: "pause", goal: "*" });
		const sent = z.sent.length;
		await z.emit("session_start");
		await Bun.sleep(50);
		expect(z.sent.length).toBe(sent);
		L.append(d, { ts: L.now(), kind: "resume", goal: "*" });
	});

	test("a judge that throws synchronously leaves the worker a way forward, not a crash", async () => {
		z.h.judgeThrows = true;
		await z.cmd("judge");
		expect(z.sent.at(-1)?.m.content).toContain("The independent judge failed");
		z.h.judgeThrows = false;
	});
});

// One intent, several instruments: the night run swapped scorecards 8 times instead of splitting.
describe("decomposition and knowledge", () => {
	let d: string;
	let z: ReturnType<typeof host>;
	const run = (c: string) => exec("bash", ["-c", c], { cwd: d });
	const st = () => L.fold(L.read(d));

	beforeAll(async () => {
		d = fs.mkdtempSync(path.join(os.tmpdir(), "climb-split-"));
		await run("git init -q && git config user.email t@t && git config user.name t && echo 100 > fast.txt && echo 10 > good.txt && git add -A && git commit -qm init");
		z = host(d, "main", "split");
		await z.load();
		await z.cmd("make it fast and good");
	});
	afterAll(() => fs.rmSync(d, { recursive: true, force: true }));

	test("a goal splits into parts that each climb with their own scorecard", async () => {
		await expect(z.tool("climb_split", { parts: [{ intent: "only one" }] })).rejects.toThrow("2-4 parts");
		const out = await z.tool("climb_split", { parts: [{ intent: "fast responses", why: "latency bench" }, { intent: "good answers", why: "quality grader" }] });
		expect(out).toContain("Split g-make-it-fast-and into g-fast-responses, g-good-answers");
		const s = st();
		expect(L.parts(s, s.goals.get("g-make-it-fast-and")!).map(p => p.id)).toEqual(["g-fast-responses", "g-good-answers"]);
		await expect(z.tool("climb_scorecard", { goal: "g-make-it-fast-and", metrics: [{ name: "x", cmd: "cat fast.txt", dir: "down", target: 1 }] })).rejects.toThrow("split into parts");
		await expect(z.tool("climb_scorecard", { metrics: [{ name: "x", cmd: "cat fast.txt", dir: "down", target: 1 }] })).rejects.toThrow("Several active goals");
		await z.tool("climb_scorecard", { goal: "g-fast-responses", metrics: [{ name: "ms", cmd: "cat fast.txt", dir: "down", target: 50, noise: 0.05 }] });
		await z.tool("climb_scorecard", { goal: "g-good-answers", metrics: [{ name: "score", cmd: "cat good.txt", dir: "up", target: 20, noise: 0.05 }] });
		expect(X.statusLine(st())).toContain("g-make-it-fast-and 0% · 0/2 parts achieved");
	});

	test("knowledge is shared down the tree and repeated with the next step", async () => {
		await z.tool("climb_learn", { goal: "g-make-it-fast-and", kind: "trap", text: "fast.txt drops after a cold start; warm up before reading it" });
		await z.tool("climb_learn", { goal: "g-fast-responses", kind: "dead-end", text: "caching the parse made no difference", evidence: "x0" });
		expect(await z.tool("climb_learn", { goal: "g-fast-responses", kind: "dead-end", text: "caching the parse made no difference" })).toContain("Already recorded");
		await z.tool("climb_learn", { goal: "g-good-answers", kind: "trap", text: "good.txt is cached by the grader; clear it between runs" });
		const next = X.nextAction(st(), st().goals.get("g-fast-responses")!);
		expect(next).toContain("good.txt is cached by the grader"); // a sibling's trap reaches this part
		expect(next).toContain("Known dead ends: caching the parse made no difference");
		expect(next).toContain("Traps: fast.txt drops after a cold start");
		expect(await z.tool("climb_status", {})).toContain("knowledge: 0 facts, 1 traps, 0 dead ends");
		const ctx = (await z.emit("session.compacting")) as unknown as { context: string[] };
		expect(ctx.context[0]).toContain("[dead-end] caching the parse made no difference");
	});

	test("parts climb through the root: one heartbeat, the root's stall gates every part, achieving all parts closes the root", async () => {
		await z.tool("climb_experiment", { goal: "g-fast-responses", lever: "halve", hypothesis: "", prediction: "" });
		expect(X.statusLine(st())).toContain("x1 on g-fast-responses");
		await run("echo 40 > fast.txt && git commit -qam halve");
		const fast = await z.tool("climb_measure", {});
		expect(fast).toContain("GOAL ACHIEVED: g-fast-responses");
		expect(fast).toContain("g-good-answers");
		L.append(d, { ts: L.now(), kind: "stall", goal: "g-make-it-fast-and", stale: 3 });
		await expect(z.tool("climb_experiment", { goal: "g-good-answers", lever: "more", hypothesis: "", prediction: "" })).rejects.toThrow("independent judge is reviewing");
		await until(() => !st().goals.get("g-make-it-fast-and")!.stallPending);
		await z.tool("climb_experiment", { goal: "g-good-answers", lever: "double", hypothesis: "", prediction: "" });
		await run("echo 25 > good.txt && git commit -qam double");
		const good = await z.tool("climb_measure", {});
		expect(good).toContain("That completes g-make-it-fast-and: every part achieved");
		expect(st().goals.get("g-make-it-fast-and")!.done?.result).toBe("achieved");
		expect(L.active(st())).toEqual([]);
		const x = JSON.parse(fs.readFileSync(path.join(d, ".climb/export.json"), "utf8"));
		expect(x.goals.map((g: { done?: string }) => g.done)).toEqual(["achieved", "achieved", "achieved"]);
		expect(await z.tool("climb_learn", { goal: "g-fast-responses", kind: "fact", text: "halving fast.txt is enough for the target" })).toContain("Recorded fact");
	});
});

// Every number carries how it was validated, in a shape other systems (the benchmaxx panel) read.
describe("evidence and export", () => {
	let d: string;
	let z: ReturnType<typeof host>;
	const run = (c: string) => exec("bash", ["-c", c], { cwd: d });

	beforeAll(async () => {
		d = fs.mkdtempSync(path.join(os.tmpdir(), "climb-export-"));
		await run("git init -q && git config user.email t@t && git config user.name t && echo 100 > work.txt && echo 'cat work.txt' > bench.sh && git add -A && git commit -qm init");
		z = host(d, "main", "export");
		await z.load();
		await z.cmd("shrink work");
		await z.tool("climb_scorecard", { metrics: [{ name: "work", cmd: "bash bench.sh", dir: "down", target: 10, unit: "units", samples: 3, noise: 0.05 }], guard: "test -s work.txt" });
		await z.tool("climb_experiment", { lever: "halve", hypothesis: "less work", prediction: "work -50%" });
		await run("echo 50 > work.txt && git commit -qam halve");
		await z.tool("climb_measure", {});
		await z.tool("climb_experiment", { lever: "bloat", hypothesis: "?", prediction: "?" });
		await run("echo 80 > work.txt && git commit -qam bloat");
		await z.tool("climb_measure", {});
	});
	afterAll(() => fs.rmSync(d, { recursive: true, force: true }));

	test("cards, experiments and results carry instrument, environment, raw runs and gates", () => {
		const e = L.read(d);
		const card = e.find(x => x.kind === "card") as L.CardE;
		expect(card.instrument).toMatch(/^[0-9a-f]{16}$/);
		expect(card.env).toMatchObject({ host: os.hostname(), cpus: os.cpus().length });
		const exp = e.find(x => x.kind === "exp") as L.ExpE;
		expect(exp.runs?.work).toEqual([100, 100, 100]);
		const kept = e.find(x => x.kind === "result") as L.ResultE;
		expect(kept).toMatchObject({ verdict: "kept", runs: { work: [50, 50, 50] }, gates: { guard: "pass", instrument: "same" }, env: card.env!.hash });
		const runs = T.read(d).filter((t): t is T.RunT => t.kind === "run" && t.metric === "work");
		expect(runs.every(r => typeof r.load === "number" && typeof r.free_mb === "number")).toBe(true);
	});

	test("export.json holds one benchmaxx-style row per decided experiment and metric", async () => {
		const x = JSON.parse(fs.readFileSync(path.join(d, ".climb/export.json"), "utf8"));
		expect(x.schema).toBe("climb.export/1");
		expect(x.metric_rows).toHaveLength(2);
		const [win, loss] = x.metric_rows;
		expect(win).toMatchObject({ record_id: "g-shrink-work/x1", metric_id: "work", unit: "units", direction: "lower", before: 100, after: 50, change_percent: -50, raw_before: [100, 100, 100], reference_samples: 3, candidate_samples: 3, verdict: "kept", correctness: { gate: "PASS", scope: "test -s work.txt" } });
		expect(win.qualification).toMatchObject({ statistical_win: true, kept: true, by_proof: false });
		expect(win.baseline_commit).toMatch(/^[0-9a-f]{40}$/);
		expect(loss).toMatchObject({ record_id: "g-shrink-work/x2", verdict: "dropped", qualification: { statistical_win: false } });
		const page = fs.readFileSync(path.join(d, ".climb/panel.html"), "utf8");
		expect(page).toContain("x1 · halve");
		expect(page).toContain("✓ kept");
		expect(page).toContain("<svg class=\"spark\"");
		expect(page).toContain("Where the time went");
		await z.cmd(`export ${path.join(d, "out.json")}`);
		expect(z.notes.at(-1)).toContain("2 metric rows");
		expect(JSON.parse(fs.readFileSync(path.join(d, "out.json"), "utf8")).source_ledger_sha256).toMatch(/^[0-9a-f]{64}$/);
	});

	test("an abandoned experiment was never measured: no drop streak, no lever attempt", async () => {
		for (const n of [1, 2, 3]) {
			await z.tool("climb_experiment", { lever: "try", hypothesis: "", prediction: "" });
			await run(`echo ${60 + n} > work.txt && git commit -qam try${n}`);
			await z.tool("climb_measure", { abandon: "instrument down" });
		}
		const g = L.fold(L.read(d)).goals.get("g-shrink-work")!;
		expect(g.streak).toBe(1); // only x2's real drop
		expect(g.levers.has("try")).toBe(false);
	});
});

describe("decomposition without an independent judge", () => {
	test("the worker's diagnosis lifts the root's stall, so parts are never deadlocked", async () => {
		const d = fs.mkdtempSync(path.join(os.tmpdir(), "climb-split-nj-"));
		const run = (c: string) => exec("bash", ["-c", c], { cwd: d });
		try {
			await run("git init -q && git config user.email t@t && git config user.name t && echo 100 > a.txt && echo 100 > b.txt && git add -A && git commit -qm init");
			const z = host(d, "main", "split-nj");
			z.noJudge();
			await z.load();
			await z.cmd("shrink both");
			await z.tool("climb_split", { parts: [{ intent: "shrink a" }, { intent: "shrink b" }] });
			await z.tool("climb_scorecard", { goal: "g-shrink-a", metrics: [{ name: "a", cmd: "cat a.txt", dir: "down", target: 10, noise: 0.05 }] });
			L.append(d, { ts: L.now(), kind: "stall", goal: "g-shrink-both", stale: 3 });
			await expect(z.tool("climb_experiment", { goal: "g-shrink-a", lever: "x", hypothesis: "", prediction: "" })).rejects.toThrow("STALLED");
			await z.tool("climb_judge", { verdict: "pivot", diagnosis: "both parts wait on the same parser", next: "fix the parser first" });
			expect(L.read(d).filter(e => e.kind === "judge").at(-1)).toMatchObject({ goal: "g-shrink-both", by: "fallback" });
			expect(await z.tool("climb_experiment", { goal: "g-shrink-a", lever: "x", hypothesis: "", prediction: "" })).toContain("Registered x1");
		} finally {
			fs.rmSync(d, { recursive: true, force: true });
		}
	});
});

// Live: retrieval latency on unchanged code read 778 ms in a calm window and 946-1487 ms an hour later
// under load; a 3-run A/A said ±17%, and a test-only commit was refused as a "regression".
describe("drift", () => {
	test("noise is re-learned from all runs of unchanged code, and adoption is judged against that history", async () => {
		const d = fs.mkdtempSync(path.join(os.tmpdir(), "climb-drift-"));
		const run = (c: string) => exec("bash", ["-c", c], { cwd: d });
		const clock = L.clock.ms;
		let shift = 0;
		L.clock.ms = () => clock() + shift;
		try {
			await run("git init -q && git config user.email t@t && git config user.name t && echo 100 > .git/level && echo x > README.md && git add -A && git commit -qm init");
			const z = host(d, "main", "drift");
			await z.load();
			await z.cmd("faster");
			await z.tool("climb_scorecard", { metrics: [{ name: "ms", cmd: "cat .git/level", dir: "down", target: 10, noise: 0.05, samples: 3 }] });
			// The world gets slower: the same tree now reads 130 (no cache: 31 minutes later).
			await run("echo 130 > .git/level");
			shift = 31 * 60_000;
			await z.tool("climb_experiment", { lever: "noop", hypothesis: "", prediction: "" });
			await run("echo y >> README.md && git commit -qam noop");
			const out = await z.tool("climb_measure", {});
			expect(out).toContain("noise re-estimated at");
			// A code commit outside any experiment, measured in an even slower window: judged against history.
			await run("echo z > lib.js && git add lib.js && git commit -qm code && echo 160 > .git/level");
			shift = 62 * 60_000;
			expect(await z.tool("climb_experiment", { lever: "next", hypothesis: "", prediction: "" })).toContain("guard passes, no regression");
			await z.tool("climb_measure", { abandon: "drift test" });
			// A test-source-only commit cannot move the metric: adopted without a comparison, however slow the window.
			await run("echo 'def test_x(): pass' > test_x.py && git add test_x.py && git commit -qm tests && echo 400 > .git/level");
			shift = 93 * 60_000;
			expect(await z.tool("climb_experiment", { lever: "after", hypothesis: "", prediction: "" })).toContain("only test sources or the proof changed");
		} finally {
			L.clock.ms = clock;
			fs.rmSync(d, { recursive: true, force: true });
		}
	});
});

// The fix benchmaxx's exam uses: rate control and candidate in interleaved blocks (A B, B A) so drift cancels.
describe("paired measurement", () => {
	test("interleaving the base and the candidate cancels drift: no false regression, and a real gain survives", async () => {
		const d = fs.mkdtempSync(path.join(os.tmpdir(), "climb-paired-"));
		const ctr = path.join(os.tmpdir(), `climb-paired-ctr-${process.pid}`);
		const run = (c: string) => exec("bash", ["-c", c], { cwd: d });
		// Every run reads 10 higher than the one before: the machine keeps getting slower. The command also
		// needs an untracked data file (linked into the base) and must not see the candidate's build output.
		const cmd = `test -f data/seed && test -f "données.csv" && test ! -f dist/candidate && n=$(cat ${ctr} 2>/dev/null || echo 0); echo $((n+1)) > ${ctr}; echo $(( $(cat work.txt) + n * 10 ))`;
		const bases = new Set(fs.readdirSync(os.tmpdir()).filter(f => f.startsWith("climb-base-"))); // a live climb may have its own
		try {
			await run("git init -q && git config user.email t@t && git config user.name t && echo 100 > work.txt && echo x > README.md && printf 'data/\\ndist/\\n' > .gitignore && git add -A && git commit -qm init && mkdir -p data && touch data/seed && touch données.csv");
			const z = host(d, "main", "paired");
			await z.load();
			await z.cmd("faster");
			await z.tool("climb_scorecard", { metrics: [{ name: "ms", cmd, dir: "down", target: 10, noise: 0.05, samples: 3 }] });
			await z.tool("climb_experiment", { lever: "noop", hypothesis: "", prediction: "" });
			await run("echo y >> README.md && git commit -qam noop");
			const noop = await z.tool("climb_measure", {});
			expect(noop).toContain("paired with the base, interleaved");
			expect(noop).not.toContain("regressed");
			await z.tool("climb_experiment", { lever: "halve", hypothesis: "", prediction: "" });
			await run("echo 50 > work.txt && git commit -qam halve");
			// The candidate's build output exists only in the main tree; the base must not see it.
			await run("mkdir -p dist && touch dist/other");
			const halve = await z.tool("climb_measure", {});
			expect(halve).toContain("KEPT x2");
			expect(halve).toContain("paired with the base");
			const result = L.read(d).filter(e => e.kind === "result").at(-1) as L.ResultE;
			expect(Object.values(result.paired ?? {})[0]?.length).toBeGreaterThanOrEqual(2);
			expect(fs.readdirSync(os.tmpdir()).filter(f => f.startsWith("climb-base-") && !bases.has(f))).toEqual([]); // worktrees cleaned up
			// Both sides' runs are traced in the repo (the base side runs in a throwaway worktree).
			const since = (L.read(d).filter(e => e.kind === "exp").at(-1) as L.ExpE).ts;
			const runs = T.read(d).filter((t): t is T.RunT => t.kind === "run" && t.phase === "paired" && t.ts > since);
			expect(runs).toHaveLength(2 * Object.values(result.paired!)[0].length);
			expect((await run("git worktree list")).stdout.trim().split("\n")).toHaveLength(1);
		} finally {
			fs.rmSync(d, { recursive: true, force: true });
			fs.rmSync(ctr, { force: true });
		}
	});
});

describe("paired measurement, crashed", () => {
	test("a paired run that crashes after pairs were collected decides nothing; the experiment stays open", async () => {
		const d = fs.mkdtempSync(path.join(os.tmpdir(), "climb-paircrash-"));
		const ctr = path.join(os.tmpdir(), `climb-paircrash-ctr-${process.pid}`);
		const bctr = `${ctr}-base`;
		const run = (c: string) => exec("bash", ["-c", c], { cwd: d });
		// Drifts like the test above, so the decision needs pairs; the base side dies after its first run.
		const cmd = `case "$PWD" in *climb-base-*) b=$(cat ${bctr} 2>/dev/null || echo 0); echo $((b+1)) > ${bctr}; [ $b -ge 1 ] && exit 7;; esac; n=$(cat ${ctr} 2>/dev/null || echo 0); echo $((n+1)) > ${ctr}; echo $(( $(cat work.txt) + n * 10 ))`;
		try {
			await run("git init -q && git config user.email t@t && git config user.name t && echo 100 > work.txt && echo x > README.md && git add -A && git commit -qm init");
			const z = host(d, "main", "paircrash");
			await z.load();
			await z.cmd("faster");
			await z.tool("climb_scorecard", { metrics: [{ name: "ms", cmd, dir: "down", target: 10, noise: 0.05, samples: 3 }] });
			await z.tool("climb_experiment", { lever: "noop", hypothesis: "", prediction: "" });
			await run("echo y >> README.md && git commit -qam noop");
			await expect(z.tool("climb_measure", {})).rejects.toThrow("Measurement failed in the paired check");
			const st = L.fold(L.read(d)).goals.get("g-faster")!;
			expect(st.open?.id).toBe("x1");
			expect(st.results).toHaveLength(0);
		} finally {
			fs.rmSync(d, { recursive: true, force: true });
			fs.rmSync(ctr, { force: true });
			fs.rmSync(bctr, { force: true });
		}
	});
});

describe("move", () => {
	test("a climb in a shared, dirty checkout says so on day one and moves to a clean worktree with its ledger", async () => {
		const d = fs.mkdtempSync(path.join(os.tmpdir(), "climb-move-"));
		const wt = `${d}-wt`;
		const run = (c: string) => exec("bash", ["-c", c], { cwd: d });
		try {
			await run("git init -q && git config user.email t@t && git config user.name t && echo 100 > work.txt && echo a > other.txt && git add -A && git commit -qm init && echo edited > other.txt");
			const z = host(d, "main", "move");
			await z.load();
			await z.cmd("shrink work");
			expect(z.notes.some(n => n.includes("uncommitted changes (1 files)") && n.includes("/climb move"))).toBe(true);
			await expect(z.tool("climb_scorecard", { metrics: [{ name: "w", cmd: "cat work.txt", dir: "down", target: 50 }] })).rejects.toThrow("/climb move <path>");
			await run(`git worktree add -q ${wt} HEAD`);
			await z.cmd(`move ${wt}`);
			expect(z.notes.at(-1)).toContain(`climb moved to ${fs.realpathSync(wt)}`);
			expect(L.fold(L.read(d)).paused).toBe(true);
			const there = L.fold(L.read(wt));
			expect([...there.goals.keys()]).toEqual(["g-shrink-work"]);
			expect(there.paused).toBeFalsy();
			const y = host(wt, "main", "move-wt");
			await y.load();
			expect(await y.tool("climb_scorecard", { metrics: [{ name: "w", cmd: "cat work.txt", dir: "down", target: 50, noise: 0.05 }] })).toContain("Scorecard set");
			expect(fs.readFileSync(path.join(d, "other.txt"), "utf8").trim()).toBe("edited");
		} finally {
			await run(`git worktree remove --force ${wt}`).catch(() => {});
			fs.rmSync(wt, { recursive: true, force: true });
			fs.rmSync(d, { recursive: true, force: true });
		}
	});
});

describe("acceptance review", () => {
	test("met targets do not close a goal whose intent has an unchecked requirement", async () => {
		const d = fs.mkdtempSync(path.join(os.tmpdir(), "climb-accept-"));
		const run = (c: string) => exec("bash", ["-c", c], { cwd: d });
		try {
			await run("git init -q && git config user.email t@t && git config user.name t && echo 100 > work.txt && git add -A && git commit -qm init");
			const z = host(d, "main", "accept");
			await z.load();
			await z.cmd("shrink work and fix the unicode bug");
			await z.tool("climb_scorecard", { metrics: [{ name: "w", cmd: "cat work.txt", dir: "down", target: 50, noise: 0.05 }] });
			z.h.judge = "VERDICT: unmet\nUNMET: the unicode bug was never on the scorecard\nNEXT: add a part for the unicode bug";
			await z.tool("climb_experiment", { lever: "halve", hypothesis: "", prediction: "" });
			await run("echo 40 > work.txt && git commit -qam halve");
			const out = await z.tool("climb_measure", {});
			expect(out).toContain("KEPT x1");
			expect(out).toContain("THE INTENT IS NOT DONE");
			expect(out).toContain("the unicode bug was never on the scorecard");
			const g = L.fold(L.read(d)).goals.get("g-shrink-work-and-fix")!;
			expect(g.done).toBeUndefined();
			expect(g.reviewed?.next).toBe("add a part for the unicode bug");
			// A review hold is not a stall verdict: it must not reset the stall, streak or STUCK gates.
			expect(g.judge).toBeUndefined();
			z.h.judge = "VERDICT: achieved\nUNMET: none\nNEXT: none";
			await z.tool("climb_scorecard", { metrics: [{ name: "w", cmd: "cat work.txt", dir: "down", target: 30, noise: 0.05 }] });
			await z.tool("climb_experiment", { lever: "again", hypothesis: "", prediction: "" });
			await run("echo 20 > work.txt && git commit -qam again");
			expect(await z.tool("climb_measure", {})).toContain("GOAL ACHIEVED");
		} finally {
			fs.rmSync(d, { recursive: true, force: true });
		}
	});

	test("a goal the review holds open can verify a check that already passes: the scorecard asks the review again", async () => {
		const d = fs.mkdtempSync(path.join(os.tmpdir(), "climb-accept-verify-"));
		const run = (c: string) => exec("bash", ["-c", c], { cwd: d });
		try {
			await run("git init -q && git config user.email t@t && git config user.name t && echo 100 > work.txt && echo 0 > lost.txt && git add -A && git commit -qm init");
			const z = host(d, "main", "accept-verify");
			await z.load();
			await z.cmd("shrink work without losing reports");
			const w = { name: "w", cmd: "cat work.txt", dir: "down", target: 50, noise: 0.05 };
			const lost = { name: "lost", cmd: "cat lost.txt", dir: "down", target: 0, noise: 0.05 };
			await expect(z.tool("climb_scorecard", { metrics: [w, lost] })).rejects.toThrow("already meets its target");
			await z.tool("climb_scorecard", { metrics: [w] });
			z.h.judge = "VERDICT: unmet\nUNMET: report delivery was never checked\nNEXT: count lost reports on the kept commit";
			await z.tool("climb_experiment", { lever: "halve", hypothesis: "", prediction: "" });
			await run("echo 40 > work.txt && git commit -qam halve");
			expect(await z.tool("climb_measure", {})).toContain("THE INTENT IS NOT DONE");
			await expect(z.tool("climb_scorecard", { metrics: [{ ...w, hold: true }, { ...lost, hold: true }] })).rejects.toThrow("Give that check a target");
			// The review is asked about the whole goal: the held card's metrics stay, and must still meet their old targets.
			await expect(z.tool("climb_scorecard", { metrics: [lost] })).rejects.toThrow("Keep w on the scorecard");
			await run("echo 100 > work.txt && git commit -qam 'outside regression'");
			await expect(z.tool("climb_scorecard", { metrics: [{ ...w, hold: true }, lost] })).rejects.toThrow("w is 100 at HEAD, short of its target 50");
			await run("echo 40 > work.txt && git commit -qam 'restore'");
			// A review that cannot run does not release a goal it held; the re-ask card keeps the hold.
			z.h.judgeThrows = true;
			expect(await z.tool("climb_scorecard", { metrics: [w, lost] })).toContain("could not run this time");
			expect(L.fold(L.read(d)).goals.get("g-shrink-work-without-losing")!.done).toBeUndefined();
			z.h.judgeThrows = false;
			z.h.judge = "VERDICT: achieved\nUNMET: none\nNEXT: none";
			const out = await z.tool("climb_scorecard", { metrics: [w, lost] });
			expect(out).toContain("GOAL ACHIEVED: g-shrink-work-without-losing");
			expect(L.fold(L.read(d)).goals.get("g-shrink-work-without-losing")!.done?.result).toBe("achieved");
		} finally {
			fs.rmSync(d, { recursive: true, force: true });
		}
	});

	test("a split goal whose parts are all achieved but whose review says no is told what is missing, not to climb its old scorecard", async () => {
		const d = fs.mkdtempSync(path.join(os.tmpdir(), "climb-accept-root-"));
		const run = (c: string) => exec("bash", ["-c", c], { cwd: d });
		try {
			await run("git init -q && git config user.email t@t && git config user.name t && echo 100 > a.txt && echo 10 > b.txt && echo 50 > old.txt && git add -A && git commit -qm init");
			const z = host(d, "main", "accept-root");
			await z.load();
			await z.cmd("make it fast and good");
			const root = "g-make-it-fast-and";
			await z.tool("climb_scorecard", { metrics: [{ name: "old", cmd: "cat old.txt", dir: "down", target: 5, noise: 0.05 }] });
			await z.tool("climb_split", { parts: [{ intent: "fast responses" }, { intent: "good answers" }] });
			await z.tool("climb_scorecard", { goal: "g-fast-responses", metrics: [{ name: "ms", cmd: "cat a.txt", dir: "down", target: 50, noise: 0.05 }] });
			await z.tool("climb_scorecard", { goal: "g-good-answers", metrics: [{ name: "score", cmd: "cat b.txt", dir: "up", target: 20, noise: 0.05 }] });
			const yes = "VERDICT: achieved\nUNMET: none\nNEXT: none";
			z.h.judge = yes;
			await z.tool("climb_experiment", { goal: "g-fast-responses", lever: "halve", hypothesis: "", prediction: "" });
			await run("echo 40 > a.txt && git commit -qam halve");
			expect(await z.tool("climb_measure", { goal: "g-fast-responses" })).toContain("GOAL ACHIEVED: g-fast-responses");
			z.h.replies = [yes, "VERDICT: unmet\nUNMET: nobody listened to a real call\nNEXT: add a part that grades a real call."];
			await z.tool("climb_experiment", { goal: "g-good-answers", lever: "double", hypothesis: "", prediction: "" });
			await run("echo 25 > b.txt && git commit -qam double");
			expect(await z.tool("climb_measure", { goal: "g-good-answers" })).toContain("GOAL ACHIEVED: g-good-answers");
			const s = L.fold(L.read(d));
			expect(s.goals.get(root)!.done).toBeUndefined();
			const next = X.nextAction(s, s.goals.get(root)!);
			expect(next).toContain("Every part is achieved, yet the goal is not achieved");
			expect(next).toContain("nobody listened to a real call → add a part that grades a real call. Give that a part");
			expect(next).not.toContain("Keep climbing");
			expect(X.statusLine(s)).toContain("2/2 parts achieved · review holds it");
			z.h.judge = yes;
			await z.tool("climb_split", { goal: root, parts: [{ intent: "grade a real call" }] });
			expect(X.nextAction(L.fold(L.read(d)), L.fold(L.read(d)).goals.get(root)!)).toContain("Split into parts: g-grade-a-real-call");
		} finally {
			fs.rmSync(d, { recursive: true, force: true });
		}
	});

	test("a review that cannot run closes the goal marked unreviewed, never as reviewed; a closed goal points to a new part", async () => {
		const d = fs.mkdtempSync(path.join(os.tmpdir(), "climb-accept-failed-"));
		const run = (c: string) => exec("bash", ["-c", c], { cwd: d });
		try {
			await run("git init -q && git config user.email t@t && git config user.name t && echo 100 > a.txt && echo 10 > b.txt && git add -A && git commit -qm init");
			const z = host(d, "main", "accept-failed");
			await z.load();
			await z.cmd("make it fast and good");
			await z.tool("climb_split", { parts: [{ intent: "fast responses" }, { intent: "good answers" }] });
			await z.tool("climb_scorecard", { goal: "g-fast-responses", metrics: [{ name: "ms", cmd: "cat a.txt", dir: "down", target: 50, noise: 0.05 }] });
			z.h.judgeThrows = true;
			await z.tool("climb_experiment", { goal: "g-fast-responses", lever: "halve", hypothesis: "", prediction: "" });
			await run("echo 40 > a.txt && git commit -qam halve");
			const out = await z.tool("climb_measure", { goal: "g-fast-responses" });
			expect(out).toContain("GOAL ACHIEVED: g-fast-responses");
			expect(out).toContain("Nothing checked the intent beyond the scorecard for g-fast-responses: the acceptance review did not run (it failed: Error: side turn refused synchronously)");
			expect(z.notes.at(-1)).toContain("g-fast-responses achieved, unreviewed");
			const done = L.fold(L.read(d)).goals.get("g-fast-responses")!.done!;
			expect(done.result).toBe("achieved");
			expect(done.unreviewed).toContain("side turn refused");
			expect(X.report(L.fold(L.read(d)), Date.now())).toContain("g-fast-responses — DONE (achieved, unreviewed)");
			expect(fs.readFileSync(path.join(d, ".climb/panel.html"), "utf8")).toContain("✓ achieved · unreviewed");
			const x = JSON.parse(fs.readFileSync(path.join(d, ".climb/export.json"), "utf8"));
			expect(x.goals.find((g: { id: string }) => g.id === "g-fast-responses").unreviewed).toContain("side turn refused");
			// A shortened id that matches one open goal is that goal; an ambiguous one is refused.
			await z.tool("climb_learn", { goal: "g-good-ans", kind: "fact", text: "Answers are graded by hand." });
			expect(L.read(d).filter(e => e.kind === "learn").at(-1)?.goal).toBe("g-good-answers");
			await expect(z.tool("climb_learn", { goal: "g-", kind: "fact", text: "x" })).rejects.toThrow('No active goal "g-"');
			// New work in a closed part's area goes in a new part, not into a sibling.
			await expect(z.tool("climb_probe", { goal: "g-fast-responses", name: "p", cmd: "echo 1" })).rejects.toThrow(
				"g-fast-responses is closed (achieved); new work in its area is a new part: climb_split on g-make-it-fast-and with one part.",
			);
		} finally {
			fs.rmSync(d, { recursive: true, force: true });
		}
	});

	test("a hold that only looks regressed at closure (the machine drifted) is checked in pairs and does not keep the goal open", async () => {
		const d = fs.mkdtempSync(path.join(os.tmpdir(), "climb-hold-drift-"));
		const ctr = path.join(d, ".git", "ctr");
		const thr = path.join(d, ".git", "thr");
		const run = (c: string) => exec("bash", ["-c", c], { cwd: d });
		// From run `thr` on, every run of the hold reads 30% slower: the machine, not the code (the base side reads it too).
		const h = `n=$(cat ${ctr} 2>/dev/null || echo 0); echo $((n+1)) > ${ctr}; [ $n -lt $(cat ${thr}) ] && echo 1000 || echo 1300`;
		try {
			await run(`git init -q && git config user.email t@t && git config user.name t && echo 100 > work.txt && git add -A && git commit -qm init && echo 99999 > ${thr}`);
			const z = host(d, "main", "hold-drift");
			await z.load();
			await z.cmd("shrink work");
			await z.tool("climb_scorecard", { metrics: [{ name: "w", cmd: "cat work.txt", dir: "down", target: 50, noise: 0.05 }, { name: "h", cmd: h, dir: "down", hold: true, noise: 0.05 }] });
			await z.tool("climb_experiment", { lever: "halve", hypothesis: "", prediction: "" });
			await run(`echo $(( $(cat ${ctr}) + 1 )) > ${thr} && echo 40 > work.txt && git commit -qam halve`);
			z.h.judge = "VERDICT: achieved\nUNMET: none\nNEXT: none";
			const out = await z.tool("climb_measure", {});
			expect(out).toContain("KEPT x1");
			expect(out).toContain("GOAL ACHIEVED: g-shrink-work");
			expect(T.read(d).some(t => t.kind === "run" && t.phase === "paired" && t.metric === "h")).toBe(true);
		} finally {
			fs.rmSync(d, { recursive: true, force: true });
		}
	});

	test("a goal with every target met but not closed is routed to confirm it; a hold that really regressed since its card is refused in pairs", async () => {
		const d = fs.mkdtempSync(path.join(os.tmpdir(), "climb-reached-"));
		const run = (c: string) => exec("bash", ["-c", c], { cwd: d });
		try {
			await run("git init -q && git config user.email t@t && git config user.name t && echo 100 > work.txt && echo 100 > h.txt && git add -A && git commit -qm init");
			const z = host(d, "main", "reached");
			await z.load();
			await z.cmd("shrink work");
			const w = { name: "w", cmd: "cat work.txt", dir: "down", target: 50, noise: 0.05 };
			const hold = { name: "h", cmd: "cat h.txt", dir: "down", hold: true, noise: 0.05 };
			await z.tool("climb_scorecard", { metrics: [w, hold] });
			const id = "g-shrink-work";
			const base = (await run("git rev-parse HEAD")).stdout.trim();
			// Kept with every target met, but the closure did not confirm it (the state the live climb was left in).
			await run("echo 40 > work.txt && echo 120 > h.txt && git commit -qam both");
			const headSha = (await run("git rev-parse HEAD")).stdout.trim();
			L.append(
				d,
				{ ts: L.now(), kind: "exp", goal: id, id: "x1", lever: "halve", hypothesis: "", prediction: "", base, ref: { w: 100, h: 100 } },
				{ ts: L.now(), kind: "result", goal: id, exp: "x1", head: headSha, values: { w: 40, h: 100 }, verdict: "kept", reason: "w 100→40" },
			);
			const s = L.fold(L.read(d));
			expect(X.reached(s.goals.get(id)!)).toBe(true);
			expect(X.nextAction(s, s.goals.get(id)!)).toContain("Every target is met, yet g-shrink-work is not closed");
			await expect(z.tool("climb_scorecard", { metrics: [w, hold] })).rejects.toThrow("h 100→120 regressed beyond its tolerance since the scorecard");
			await run("echo 100 > h.txt && git commit -qam restore");
			z.h.judge = "VERDICT: achieved\nUNMET: none\nNEXT: none";
			expect(await z.tool("climb_scorecard", { metrics: [w, hold] })).toContain("GOAL ACHIEVED: g-shrink-work");
		} finally {
			fs.rmSync(d, { recursive: true, force: true });
		}
	});

	test("a hold regressed within its own tolerance, then pushed over by drift at closure, does not keep the goal open", async () => {
		const d = fs.mkdtempSync(path.join(os.tmpdir(), "climb-hold-tol-"));
		const ctr = path.join(d, ".git", "ctr");
		const thr = path.join(d, ".git", "thr");
		const run = (c: string) => exec("bash", ["-c", c], { cwd: d });
		const h = `n=$(cat ${ctr} 2>/dev/null || echo 0); echo $((n+1)) > ${ctr}; v=$(cat h.txt); [ $n -lt $(cat ${thr}) ] && echo $v || echo $((v*110/100))`;
		try {
			await run(`git init -q && git config user.email t@t && git config user.name t && echo 100 > work.txt && echo 1000 > h.txt && git add -A && git commit -qm init && echo 99999 > ${thr}`);
			const z = host(d, "main", "hold-tol");
			await z.load();
			await z.cmd("shrink work");
			await z.tool("climb_scorecard", { metrics: [{ name: "w", cmd: "cat work.txt", dir: "down", target: 50, noise: 0.05 }, { name: "h", cmd: h, dir: "down", hold: true, noise: 0.08 }] });
			await z.tool("climb_experiment", { lever: "halve", hypothesis: "", prediction: "" });
			// A real 3% hold regression (inside its 8% tolerance); the machine slows 10% from the confirmation on.
			await run(`echo $(( $(cat ${ctr}) + 1 )) > ${thr} && echo 40 > work.txt && echo 1030 > h.txt && git commit -qam halve`);
			z.h.judge = "VERDICT: achieved\nUNMET: none\nNEXT: none";
			expect(await z.tool("climb_measure", {})).toContain("GOAL ACHIEVED: g-shrink-work");
		} finally {
			fs.rmSync(d, { recursive: true, force: true });
		}
	});

	test("confirming a target met once that comes out just short at HEAD re-baselines it, and the climb goes on", async () => {
		const d = fs.mkdtempSync(path.join(os.tmpdir(), "climb-near-miss-"));
		const run = (c: string) => exec("bash", ["-c", c], { cwd: d });
		try {
			await run("git init -q && git config user.email t@t && git config user.name t && echo 100 > work.txt && git add -A && git commit -qm init");
			const z = host(d, "main", "near-miss");
			await z.load();
			await z.cmd("shrink work");
			const w = { name: "w", cmd: "cat work.txt", dir: "down", target: 50, noise: 0.05 };
			await z.tool("climb_scorecard", { metrics: [w] });
			const id = "g-shrink-work";
			const base = (await run("git rev-parse HEAD")).stdout.trim();
			// The kept draw read 49; HEAD is really 51.
			await run("echo 51 > work.txt && git commit -qam step");
			const headSha = (await run("git rev-parse HEAD")).stdout.trim();
			L.append(
				d,
				{ ts: L.now(), kind: "exp", goal: id, id: "x1", lever: "halve", hypothesis: "", prediction: "", base, ref: { w: 100 } },
				{ ts: L.now(), kind: "result", goal: id, exp: "x1", head: headSha, values: { w: 49 }, verdict: "kept", reason: "w 100→49" },
			);
			expect(X.nextAction(L.fold(L.read(d)), L.fold(L.read(d)).goals.get(id)!)).toContain("climb_scorecard with the same checks");
			expect(await z.tool("climb_scorecard", { metrics: [w] })).toContain("climb_experiment");
			const s = L.fold(L.read(d));
			expect(X.reached(s.goals.get(id)!)).toBe(false);
			expect(X.nextAction(s, s.goals.get(id)!)).toContain("Keep climbing");
		} finally {
			fs.rmSync(d, { recursive: true, force: true });
		}
	});

	test("/climb done needs a goal's exact id: a near miss never resolves to a parent", async () => {
		const d = fs.mkdtempSync(path.join(os.tmpdir(), "climb-done-exact-"));
		const run = (c: string) => exec("bash", ["-c", c], { cwd: d });
		try {
			await run("git init -q && git config user.email t@t && git config user.name t && echo 100 > a.txt && git add -A && git commit -qm init");
			const z = host(d, "main", "done-exact");
			await z.load();
			await z.cmd("reduce latency");
			await z.tool("climb_split", { parts: [{ intent: "reduce latency of search" }, { intent: "reduce latency of tts" }] });
			const ids = [...L.fold(L.read(d)).goals.keys()];
			const search = ids.find(i => i.includes("search"))!;
			await z.cmd(`done ${search}`);
			await z.cmd(`done ${search.slice(0, -3)}`);
			const s = L.fold(L.read(d));
			expect([...s.goals.values()].filter(g => !g.done).map(g => g.id).sort()).toEqual(ids.filter(i => i !== search).sort());
			expect(z.notes.at(-1)).toContain("No active goal");
		} finally {
			fs.rmSync(d, { recursive: true, force: true });
		}
	});

	test("a parent whose open parts are achieved closes even when the user dropped another part", async () => {
		const d = fs.mkdtempSync(path.join(os.tmpdir(), "climb-dropped-part-"));
		const run = (c: string) => exec("bash", ["-c", c], { cwd: d });
		try {
			await run("git init -q && git config user.email t@t && git config user.name t && echo 100 > a.txt && git add -A && git commit -qm init");
			const z = host(d, "main", "dropped-part");
			await z.load();
			await z.cmd("make it fast and good");
			await z.tool("climb_split", { parts: [{ intent: "fast responses" }, { intent: "good answers" }] });
			await z.cmd("done g-good-answers");
			expect(L.fold(L.read(d)).goals.get("g-good-answers")!.done?.result).toBe("abandoned");
			await z.tool("climb_scorecard", { goal: "g-fast-responses", metrics: [{ name: "ms", cmd: "cat a.txt", dir: "down", target: 50, noise: 0.05 }] });
			z.h.judge = "VERDICT: achieved\nUNMET: none\nNEXT: none";
			await z.tool("climb_experiment", { goal: "g-fast-responses", lever: "halve", hypothesis: "", prediction: "" });
			await run("echo 40 > a.txt && git commit -qam halve");
			const out = await z.tool("climb_measure", { goal: "g-fast-responses" });
			expect(out).toContain("That completes g-make-it-fast-and");
			expect(L.fold(L.read(d)).goals.get("g-make-it-fast-and")!.done?.result).toBe("achieved");
			// The other order: the last open part is dropped after its sibling was achieved.
			await z.cmd("make it small and quick");
			await z.tool("climb_split", { goal: "g-make-it-small-and", parts: [{ intent: "small bundle" }, { intent: "quick start" }] });
			await z.tool("climb_scorecard", { goal: "g-small-bundle", metrics: [{ name: "kb", cmd: "cat a.txt", dir: "down", target: 30, noise: 0.05 }] });
			await z.tool("climb_experiment", { goal: "g-small-bundle", lever: "shrink", hypothesis: "", prediction: "" });
			await run("echo 20 > a.txt && git commit -qam shrink");
			expect(await z.tool("climb_measure", { goal: "g-small-bundle" })).toContain("GOAL ACHIEVED: g-small-bundle");
			await z.cmd("done g-quick-start");
			expect(L.fold(L.read(d)).goals.get("g-make-it-small-and")!.done?.result).toBe("achieved");
		} finally {
			fs.rmSync(d, { recursive: true, force: true });
		}
	});

	test("/climb help shows usage and never starts a goal", async () => {
		const d = fs.mkdtempSync(path.join(os.tmpdir(), "climb-help-"));
		try {
			await exec("bash", ["-c", "git init -q && git config user.email t@t && git config user.name t && echo x > a && git add -A && git commit -qm init"], { cwd: d });
			const z = host(d, "main", "help");
			await z.load();
			await z.cmd("help");
			expect(z.notes.at(-1)).toContain("/climb <intent>");
			expect(L.read(d).length).toBe(0);
		} finally {
			fs.rmSync(d, { recursive: true, force: true });
		}
	});

	test("a real-sized step under the noise is dropped with the sample count that would resolve it", async () => {
		const d = fs.mkdtempSync(path.join(os.tmpdir(), "climb-near-miss-step-"));
		const run = (c: string) => exec("bash", ["-c", c], { cwd: d });
		try {
			await run("git init -q && git config user.email t@t && git config user.name t && echo 100 > work.txt && git add -A && git commit -qm init");
			const z = host(d, "main", "near-miss-step");
			await z.load();
			await z.cmd("shrink work");
			await z.tool("climb_scorecard", { metrics: [{ name: "w", cmd: "cat work.txt", dir: "down", target: 20, noise: 0.2 }] });
			await z.tool("climb_experiment", { lever: "trim", hypothesis: "", prediction: "" });
			await run("echo 85 > work.txt && git commit -qam trim");
			const out = await z.tool("climb_measure", {});
			expect(out).toContain("DROPPED x1");
			expect(out).toContain("w moved +15.0%, under its ±20.0% noise at 1 sample: a step this size shows at samples 3");
		} finally {
			fs.rmSync(d, { recursive: true, force: true });
		}
	});

	test("a metric pinned at one value far from its target (a cap or failure penalty) is called out", async () => {
		const d = fs.mkdtempSync(path.join(os.tmpdir(), "climb-pinned-"));
		const run = (c: string) => exec("bash", ["-c", c], { cwd: d });
		try {
			await run("git init -q && git config user.email t@t && git config user.name t && echo 75000 > p90.txt && git add -A && git commit -qm init");
			const z = host(d, "main", "pinned");
			await z.load();
			await z.cmd("faster answers");
			const out = await z.tool("climb_scorecard", { metrics: [{ name: "answer_p90_ms", cmd: "cat p90.txt", dir: "down", target: 1500, noise: 0.01 }] });
			expect(out).toContain("answer_p90_ms read exactly 75000 on every A/A run, 50× its target");
			expect(out).toContain("count those failures in a metric of their own (target 0)");
		} finally {
			fs.rmSync(d, { recursive: true, force: true });
		}
	});

	test("a small, noisy failure count is refused with advice that fits counts", async () => {
		const d = fs.mkdtempSync(path.join(os.tmpdir(), "climb-small-count-"));
		const ctr = path.join(d, ".git", "ctr");
		const run = (c: string) => exec("bash", ["-c", c], { cwd: d });
		try {
			await run("git init -q && git config user.email t@t && git config user.name t && echo x > a && git add -A && git commit -qm init");
			const z = host(d, "main", "small-count");
			await z.load();
			await z.cmd("no missed answers");
			// 0, 1, 2, 0, 1, 2 ... misses per run
			const cmd = `n=$(cat ${ctr} 2>/dev/null || echo 0); echo $((n+1)) > ${ctr}; echo $((n % 3))`;
			await expect(z.tool("climb_scorecard", { metrics: [{ name: "missed", cmd, dir: "down", target: 0 }] })).rejects.toThrow("A count this small is coarse: count over more cases per run");
		} finally {
			fs.rmSync(d, { recursive: true, force: true });
		}
	});

	test("a part the review holds open comes next, with what is missing, not a sibling's climb", async () => {
		const d = fs.mkdtempSync(path.join(os.tmpdir(), "climb-accept-part-"));
		const run = (c: string) => exec("bash", ["-c", c], { cwd: d });
		try {
			await run("git init -q && git config user.email t@t && git config user.name t && echo 100 > a.txt && echo 10 > b.txt && git add -A && git commit -qm init");
			const z = host(d, "main", "accept-part");
			await z.load();
			await z.cmd("make it fast and good");
			await z.tool("climb_split", { parts: [{ intent: "fast responses" }, { intent: "good answers" }] });
			await z.tool("climb_scorecard", { goal: "g-fast-responses", metrics: [{ name: "ms", cmd: "cat a.txt", dir: "down", target: 50, noise: 0.05 }] });
			await z.tool("climb_scorecard", { goal: "g-good-answers", metrics: [{ name: "score", cmd: "cat b.txt", dir: "up", target: 20, noise: 0.05 }] });
			z.h.judge = "VERDICT: unmet\nUNMET: background reports were never checked\nNEXT: run the delivery bench on the kept commit";
			await z.tool("climb_experiment", { goal: "g-fast-responses", lever: "halve", hypothesis: "", prediction: "" });
			await run("echo 40 > a.txt && git commit -qam halve");
			const out = await z.tool("climb_measure", { goal: "g-fast-responses" });
			expect(out).toContain("THE INTENT IS NOT DONE");
			expect(out).not.toContain("Next, g-good-answers");
			const s = L.fold(L.read(d));
			const next = X.nextAction(s, s.goals.get("g-make-it-fast-and")!);
			expect(next).toContain("Next, g-fast-responses: [climb g-fast-responses] Every target is met, yet the goal is not achieved");
			expect(next).toContain("The acceptance review: background reports were never checked → run the delivery bench on the kept commit");
			expect(next).toContain("one that already passes is welcome");
			expect(next).not.toContain("metric furthest from target");
		} finally {
			fs.rmSync(d, { recursive: true, force: true });
		}
	});
});

describe("updates", () => {
	test("a running session says so when a newer climb is installed", async () => {
		const d = fs.mkdtempSync(path.join(os.tmpdir(), "climb-update-"));
		const src = path.join(import.meta.dir, "../src/trace.ts");
		const was = fs.statSync(src);
		try {
			await exec("bash", ["-c", "git init -q && git config user.email t@t && git config user.name t && echo 1 > a && git add -A && git commit -qm i"], { cwd: d });
			const z = host(d, "main", "update");
			await z.load();
			await z.cmd("anything");
			z.h.timerFn!();
			await Bun.sleep(50);
			expect(z.notes.some(n => n.includes("newer version"))).toBe(false);
			fs.utimesSync(src, was.atime, new Date(Date.now() + 60_000));
			z.h.timerFn!();
			await until(() => z.notes.some(n => n.includes("newer version is installed")));
		} finally {
			fs.utimesSync(src, was.atime, was.mtime);
			fs.rmSync(d, { recursive: true, force: true });
		}
	});
});

describe("base worktree safety", () => {
	test("links back into tracked code block pairing; environments and build outputs are never shared", () => {
		const d = fs.mkdtempSync(path.join(os.tmpdir(), "climb-leak-"));
		try {
			fs.mkdirSync(path.join(d, "packages/pkg"), { recursive: true });
			fs.mkdirSync(path.join(d, "node_modules/.pnpm/dep/node_modules/dep"), { recursive: true });
			fs.mkdirSync(path.join(d, "node_modules/@scope"), { recursive: true });
			// pnpm's internal links stay inside node_modules: safe to share.
			fs.symlinkSync(path.join(d, "node_modules/.pnpm/dep/node_modules/dep"), path.join(d, "node_modules/dep"));
			expect(leaksIntoRepo(d, "node_modules", ["node_modules"])).toBe(false);
			// A workspace package resolves into the repo's own code: the base would run the candidate's.
			fs.symlinkSync(path.join(d, "packages/pkg"), path.join(d, "node_modules/@scope/pkg"));
			expect(leaksIntoRepo(d, "node_modules", ["node_modules"])).toBe(true);
			for (const env of [".venv", "venv", "sub/.tox"]) expect(ENVS.test(env)).toBe(true);
			for (const out of ["dist", "lib", "web/.svelte-kit", "app.tsbuildinfo", "pkg/__pycache__"]) expect(DERIVED.test(out)).toBe(true);
			for (const keep of ["node_modules", ".env", "data", "bench/runs"]) expect(DERIVED.test(keep) || ENVS.test(keep)).toBe(false);
		} finally {
			fs.rmSync(d, { recursive: true, force: true });
		}
	});
});

describe("flaky guard", () => {
	test("a guard that fails once and passes on a retry passes, and is called flaky", async () => {
		const d = fs.mkdtempSync(path.join(os.tmpdir(), "climb-flakyguard-"));
		const run = (c: string) => exec("bash", ["-c", c], { cwd: d });
		try {
			await run("git init -q && git config user.email t@t && git config user.name t && echo 100 > work.txt && git add -A && git commit -qm init");
			const z = host(d, "main", "flakyguard");
			await z.load();
			await z.cmd("shrink");
			// Fails on its first-ever run only.
			const guard = "test -f .git/guard-ran || { touch .git/guard-ran; exit 1; }";
			const out = await z.tool("climb_scorecard", { metrics: [{ name: "w", cmd: "cat work.txt", dir: "down", target: 10, noise: 0.05 }], guard });
			expect(out).toContain("Scorecard set");
			expect(out).toContain("guard failed once");
			expect(out).toContain("it is flaky");
		} finally {
			fs.rmSync(d, { recursive: true, force: true });
		}
	});
	test("a failing guard shows what it printed on stdout too (bun run echoes on stderr, tsc errs on stdout)", async () => {
		const d = fs.mkdtempSync(path.join(os.tmpdir(), "climb-guardout-"));
		const run = (c: string) => exec("bash", ["-c", c], { cwd: d });
		try {
			await run("git init -q && git config user.email t@t && git config user.name t && echo 100 > work.txt && git add -A && git commit -qm init");
			const z = host(d, "main", "guardout");
			await z.load();
			await z.cmd("shrink");
			const guard = "echo '$ tsc --noEmit' >&2; echo 'a.ts(1,1): error TS1375: await needs a module'; exit 2";
			await expect(z.tool("climb_scorecard", { metrics: [{ name: "w", cmd: "cat work.txt", dir: "down", target: 10, noise: 0.05 }], guard })).rejects.toThrow("TS1375");
		} finally {
			fs.rmSync(d, { recursive: true, force: true });
		}
	});
});

describe("heartbeat while the extension measures", () => {
	test("an hour spent measuring holds the stale count; the next empty hour counts", async () => {
		const d = fs.mkdtempSync(path.join(os.tmpdir(), "climb-measuring-"));
		const hold = `${d}-hold`;
		const run = (c: string) => exec("bash", ["-c", c], { cwd: d });
		const real = L.clock.ms;
		try {
			await run("git init -q && git config user.email t@t && git config user.name t && echo 100 > work.txt && git add -A && git commit -qm init");
			const z = host(d, "main", "measuring");
			await z.load();
			await z.cmd("shrink work --beat 30m --poke-max 3");
			await z.tool("climb_scorecard", { metrics: [{ name: "work", cmd: `while [ -f ${hold} ]; do sleep 0.05; done; cat work.txt`, dir: "down", target: 10, noise: 0.05 }] });
			const t0 = real();
			const beats = () => L.read(d).filter((e): e is L.BeatE => e.kind === "beat");
			const fire = async (min: number) => {
				L.clock.ms = () => t0 + min * 60_000 + (real() - t0);
				z.h.idle = false;
				z.h.timerFn!();
				await Bun.sleep(300);
			};
			await fire(61);
			expect(beats().at(-1)).toMatchObject({ progress: true, stale: 0 }); // the first scorecard
			await z.tool("climb_experiment", { lever: "nothing", hypothesis: "", prediction: "" });
			await run("git commit -q --allow-empty -m noop");
			fs.writeFileSync(hold, "");
			const measured = z.tool("climb_measure", {});
			await Bun.sleep(300);
			await fire(122);
			expect(beats().at(-1)).toMatchObject({ progress: false, stale: 0, note: "x1 open · measuring" });
			fs.rmSync(hold);
			expect(await measured).toContain("DROPPED x1");
			await fire(183);
			expect(beats().at(-1)).toMatchObject({ progress: false, stale: 1 });
		} finally {
			L.clock.ms = real;
			fs.rmSync(hold, { force: true });
			fs.rmSync(d, { recursive: true, force: true });
		}
	});
});

// Live: voice's x5 measurement was cut off after an hour of runs (eval's timeout) and the retry measured it all again;
// its drifting metrics paid 40 minutes of plain runs that the pairs then overruled, and each control re-measured the base.
describe("resumed measurement", () => {
	test("a drifting metric goes straight to pairs, a cut-off measurement resumes from its finished pairs, and a drop's base side is the next control", async () => {
		const d = fs.mkdtempSync(path.join(os.tmpdir(), "climb-resume-"));
		const [ctr, hold, at] = [`${d}-ctr`, `${d}-hold`, `${d}-at`];
		const run = (c: string) => exec("bash", ["-c", c], { cwd: d });
		// Every run reads 10 higher than the one before (drift); the run numbered in `at` waits while `hold` exists.
		const cmd = `n=$(cat ${ctr} 2>/dev/null || echo 0); echo $((n+1)) > ${ctr}; if [ "$n" = "$(cat ${at} 2>/dev/null)" ]; then while [ -f ${hold} ]; do sleep 0.05; done; fi; echo $(( $(cat work.txt) + n * 10 ))`;
		const count = () => Number(fs.readFileSync(ctr, "utf8"));
		const clock = L.clock.ms;
		try {
			await run("git init -q && git config user.email t@t && git config user.name t && echo 100 > work.txt && echo x > README.md && git add -A && git commit -qm init");
			const z = host(d, "main", "resume");
			await z.load();
			await z.cmd("faster");
			await z.tool("climb_scorecard", { metrics: [{ name: "ms", cmd, dir: "down", target: 10, noise: 0.05, samples: 3 }] });
			await z.tool("climb_experiment", { lever: "noop", hypothesis: "", prediction: "" });
			await run("echo y >> README.md && git commit -qam noop");
			L.clock.ms = () => clock() + 31 * 60_000; // the base's A/A and control runs are stale now
			expect(await z.tool("climb_measure", {})).toContain("DROPPED x1");
			// The revert restored the base tree: its side of x1's pairs is x2's control.
			const before = count();
			expect(await z.tool("climb_experiment", { lever: "halve", hypothesis: "", prediction: "" })).toContain("reused runs of this tree");
			expect(count()).toBe(before);
			await run("echo 50 > work.txt && git commit -qam halve");
			// Cut off in the second pair, once the first has finished.
			fs.writeFileSync(at, String(count() + 3));
			fs.writeFileSync(hold, "");
			const ac = new AbortController();
			const cut = z.toolWith("climb_measure", {}, ac.signal).catch((e: Error) => e.message);
			await until(() => count() > Number(fs.readFileSync(at, "utf8")));
			ac.abort();
			fs.rmSync(hold);
			expect(await cut).toContain("climb_measure resumes from them");
			const resumedAt = count();
			expect(await z.tool("climb_measure", {})).toContain("KEPT x2");
			const exp = L.read(d).filter((e): e is L.ExpE => e.kind === "exp").at(-1)!;
			const pairs = (L.read(d).filter((e): e is L.ResultE => e.kind === "result").at(-1)!.paired ?? {}).ms ?? [];
			const traced = T.read(d).filter(t => t.ts > exp.ts);
			expect(traced.filter(t => t.kind === "run" && t.phase === "result")).toHaveLength(0); // drifting: no plain runs
			expect(traced.find(t => t.kind === "reuse" && t.phase === "paired")).toMatchObject({ runs: 2 });
			expect(pairs.length).toBeGreaterThanOrEqual(3);
			expect(count() - resumedAt).toBe(2 * (pairs.length - 1)); // only the pairs not finished before the cut
		} finally {
			L.clock.ms = clock;
			for (const f of [ctr, hold, at]) fs.rmSync(f, { force: true });
			fs.rmSync(d, { recursive: true, force: true });
		}
	});
});

// Live: voice's answered_p50_ms read ~1.8 s or ~2.7 s run to run; its pairs measured ±55% noise against a 46% way
// to target, so every 3-hour measurement was a coin toss, and a likely slowdown passed as "no metric regressed".
describe("an instrument noisier than its target", () => {
	test("pairs noisier than the whole way to the target are named at measure, and refuse the next experiment without a proof", async () => {
		const d = fs.mkdtempSync(path.join(os.tmpdir(), "climb-deaf-"));
		const ctr = `${d}-ctr`;
		const run = (c: string) => exec("bash", ["-c", c], { cwd: d });
		// Calm back to back (the A/A), then two modes far apart: 100 or 200, whatever the code.
		const cmd = `n=$(cat ${ctr} 2>/dev/null || echo 0); echo $((n+1)) > ${ctr}; if [ $n -lt 3 ]; then echo $((100 + n)); else echo $(( n % 2 ? 100 : 200 )); fi`;
		const clock = L.clock.ms;
		try {
			await run("git init -q && git config user.email t@t && git config user.name t && echo x > README.md && git add -A && git commit -qm init");
			const z = host(d, "main", "deaf");
			await z.load();
			await z.cmd("faster");
			await z.tool("climb_scorecard", { metrics: [{ name: "ms", cmd, dir: "down", target: 70, noise: 0.05, samples: 3 }] });
			// The first measurement shows the two modes; the second, knowing the drift, is decided in pairs.
			let out = "";
			for (const lever of ["noop", "noop again"]) {
				await z.tool("climb_experiment", { lever, hypothesis: "", prediction: "" });
				await run(`echo ${lever.length} >> README.md && git commit -qam noop`);
				out = await z.tool("climb_measure", {});
			}
			expect(out).toContain("paired with the base");
			expect(out).toContain("no step on it can be told apart from luck");
			await expect(z.tool("climb_experiment", { lever: "next", hypothesis: "", prediction: "" })).rejects.toThrow("No measurement can keep this experiment");
			// A proof can still keep a verified fix; the gate only stops coin tosses.
			await run("printf 'test -f fixed\\n' > check.sh && git add check.sh && git commit -qm check");
			expect(await z.tool("climb_experiment", { lever: "fix", hypothesis: "", prediction: "", proof: "bash check.sh" })).toContain("Registered");
		} finally {
			L.clock.ms = clock;
			fs.rmSync(ctr, { force: true });
			fs.rmSync(d, { recursive: true, force: true });
		}
	});
});

// Live: voice's measurements kept every call's recordings, 9 GB a day, with 16 GB left on the disk.
describe("disk", () => {
	test("measuring stops before the disk fills, deciding nothing; a measurement that ate the disk says so", async () => {
		const d = fs.mkdtempSync(path.join(os.tmpdir(), "climb-disk-"));
		const [free, next] = [`${d}-free`, `${d}-next`];
		const run = (c: string) => exec("bash", ["-c", c], { cwd: d });
		const real = disk.free;
		// Free space in GiB comes from a file; the metric command sets it from `next`, like an instrument writing outputs.
		disk.free = () => Number(fs.readFileSync(free, "utf8")) * 2 ** 30;
		try {
			fs.writeFileSync(free, "50");
			fs.writeFileSync(next, "50");
			await run("git init -q && git config user.email t@t && git config user.name t && echo 100 > work.txt && git add -A && git commit -qm init");
			const z = host(d, "main", "disk");
			await z.load();
			await z.cmd("shrink work");
			await z.tool("climb_scorecard", { metrics: [{ name: "work", cmd: `cat ${next} > ${free}; cat work.txt`, dir: "down", target: 10, noise: 0.05 }] });
			await z.tool("climb_experiment", { lever: "halve", hypothesis: "", prediction: "" });
			await run("echo 50 > work.txt && git commit -qam halve");
			fs.writeFileSync(free, "1.5");
			await expect(z.tool("climb_measure", {})).rejects.toThrow("The disk is nearly full (1.5 GiB free)");
			expect(L.fold(L.read(d)).goals.get("g-shrink-work")!.open?.id).toBe("x1");
			fs.writeFileSync(free, "50");
			fs.writeFileSync(next, "48");
			const out = await z.tool("climb_measure", {});
			expect(out).toContain("KEPT x1");
			expect(out).toContain("the disk lost 2.0 GiB while this measured");
		} finally {
			disk.free = real;
			for (const f of [free, next]) fs.rmSync(f, { force: true });
			fs.rmSync(d, { recursive: true, force: true });
		}
	});
});
