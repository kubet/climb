import { describe, expect, test } from "bun:test";
import * as L from "../src/ledger";
import * as X from "../src/logic";
import * as T from "../src/trace";

const metric = (o: Partial<L.Metric> = {}): L.Metric => ({
	name: "ms",
	cmd: "echo 1",
	dir: "down",
	baseline: 100,
	target: 10,
	noise: 0.02,
	samples: 1,
	timeout_s: 10,
	...o,
});

const iso = (msAgo: number, nowMs: number) => new Date(nowMs - msAgo).toISOString();

describe("logic", () => {
	test("parseNumber takes the last number of the last numeric line", () => {
		expect(X.parseNumber("compiling...\ntook 12.5 ms\n")).toBe(12.5);
		expect(X.parseNumber("a 1 b 2\n\n")).toBe(2);
		expect(X.parseNumber("1.5e3")).toBe(1500);
		expect(X.parseNumber("-3")).toBe(-3);
		expect(X.parseNumber("nothing")).toBeUndefined();
	});

	test("verdict: keep only gains beyond noise, drop any regression", () => {
		const ms = metric();
		const ok = metric({ name: "ok", dir: "up", baseline: 1, target: 2 });
		expect(X.verdict([ms], { ms: 100 }, { ms: 50 }).kept).toBe(true);
		expect(X.verdict([ms], { ms: 100 }, { ms: 99 }).kept).toBe(false); // 1% < 2% noise
		const mixed = X.verdict([ms, ok], { ms: 100, ok: 1 }, { ms: 50, ok: 0.5 });
		expect(mixed.kept).toBe(false);
		expect(mixed.reason).toContain("regressed");
	});

	test("a hold metric guards but never keeps: bouncing back from an unlucky control is not a gain", () => {
		const work = metric({ name: "work" });
		const ms = metric({ hold: true, noise: 0.05 });
		const v = X.verdict([work, ms], { work: 100, ms: 120 }, { work: 100, ms: 100 }); // unlucky slow control
		expect(v).toMatchObject({ kept: false, regressed: false });
		expect(X.verdict([work, ms], { work: 100, ms: 50 }, { work: 100, ms: 70 }).regressed).toBe(true);
		expect(X.borderline([ms], { ms: 100 }, { ms: 93 })).toBe(false); // improved: nothing to re-check
		expect(X.borderline([ms], { ms: 100 }, { ms: 107 })).toBe(true); // fell within 2x noise: re-check
	});

	test("noise is the decision's, not one run's: it shrinks with samples, and says how many are needed", () => {
		expect(X.noiseOf([100, 100, 100], 100, 1)).toBe(0);
		const one = X.noiseOf([90, 100, 110], 100, 1);
		expect(one).toBeCloseTo(2 * Math.SQRT2 * 0.1, 5); // sd 10 on 100
		expect(X.noiseOf([90, 100, 110], 100, 9)).toBeLessThan(one / 2);
		expect(X.samplesFor([90, 100, 110], 100, 0.2)).toBe(4);
		expect(X.samplesFor([4000, 700, 1200], 1200, 0.5)).toBeUndefined(); // a sentinel-bimodal metric: no sample count saves it
	});

	test("proof and outside-instrument path detection", () => {
		expect(X.scriptPaths("bash checks/fixed.sh && python3 ./tests/t_x.py -q && python3 check.py")).toEqual(["checks/fixed.sh", "tests/t_x.py", "check.py"]);
		expect(X.scriptPaths(`bun -e 'console.log(1); import x from "./src/a"'`)).toEqual([]);
		expect(X.scriptPaths("test \"$(cat fixed.txt)\" = yes")).toEqual([]);
		// A path built from a shell variable is not a static file to check — the proof is run to validate it (a worker's
		// `bench/$p-proof.ts` loop was being refused as "does not exist yet" over and over).
		expect(X.scriptPaths("bun --env-file=.env bench/$p-proof.ts")).toEqual([]);
		expect(X.scriptPaths("for p in glance pre; do test \"$(bun bench/$p-proof.ts)\" -eq 0; done")).toEqual([]);
		expect(X.absolutePaths("bun bench/isolated.ts --backend=/tmp/a/b --env-file=/tmp/c.env | tail -1")).toEqual(["/tmp/a/b", "/tmp/c.env"]);
	});

	test("progress is directional and can go negative", () => {
		expect(X.progressPct(metric(), 55)).toBe(50);
		expect(X.progressPct(metric(), 10)).toBe(100);
		expect(X.progressPct(metric(), 145)).toBe(-50);
		expect(X.progressPct(metric({ dir: "up", baseline: 10, target: 20 }), 15)).toBe(50);
	});

	test("parseJudge tolerates markdown and defaults", () => {
		const j = X.parseJudge("**VERDICT:** Stuck\n**DIAGNOSIS:** network blocked\nNEXT: ask the human");
		expect(j).toEqual({ verdict: "stuck", diagnosis: "network blocked", next: "ask the human" });
		expect(X.parseJudge("garbage").verdict).toBe("continue");
	});

	test("humanOnly: work the worker can do is never stuck; only a real human need parks the climb", () => {
		// The fumble that triggered this: a judge called filing reports STUCK and parked a climb at 86%.
		expect(X.humanOnly("Human action only: file the six reports per FILE-NOW/00-READ-ME-FIRST.md", "the reports must be filed")).toBe(false);
		expect(X.humanOnly("write up the findings and commit them")).toBe(false);
		expect(X.humanOnly("run the benchmark again and record the result")).toBe(false);
		expect(X.humanOnly("fix the failing test, then re-measure")).toBe(false);
		// A genuine human-only need still parks.
		expect(X.humanOnly("provide a GitHub token with repo access", "the deploy needs a credential")).toBe(true);
		expect(X.humanOnly("decide which of the three finished designs to ship")).toBe(true);
		expect(X.humanOnly("ask the human", "needs a human")).toBe(true);
		// Money or a secret the worker cannot supply parks even when the sentence also names work.
		expect(X.humanOnly("purchase a paid Daytona plan to run the larger benchmark")).toBe(true);
		expect(X.humanOnly("update the .env file with the production key")).toBe(true);
		// But a human's mere preference ("decide") yields to work the worker can do: it drives on.
		expect(X.humanOnly("decide on a lever and run the experiment")).toBe(false);
	});

	test("concurrency parallelizes into headroom and backs off as load climbs, never below 1 or above want", () => {
		// A calm 8-core machine runs a metric at its full width.
		expect(X.concurrency(4, 0, 8)).toBe(4);
		expect(X.concurrency(4, 4, 8)).toBe(4); // load 4 of 8: still headroom
		// Load climbing past the cores backs the width off toward 1.
		expect(X.concurrency(4, 10, 8)).toBe(2);
		expect(X.concurrency(4, 11.6, 8)).toBe(1);
		expect(X.concurrency(4, 37, 8)).toBe(1); // thrashing (two climbs on a 16 GiB Mac): serialize
		// A serial metric is never touched; a small machine caps below the asked width; the result never exceeds want.
		expect(X.concurrency(1, 0, 8)).toBe(1);
		expect(X.concurrency(8, 0, 2)).toBe(3);
	});

	test("instrument detection freezes executed scripts, not the data being optimized", () => {
		const t = new Set(["bench.py", "work.txt", "scripts/m.sh", "tests/a.py", "solve.py", "test_primes.py"]);
		expect(X.instrumentFiles("python3 bench.py --n 3", t)).toEqual(["bench.py"]);
		expect(X.instrumentFiles("env -u PYTHONOPTIMIZE python3 test_primes.py", t)).toEqual(["test_primes.py"]);
		expect(X.instrumentFiles("./scripts/m.sh | tail -1", t)).toEqual(["scripts/m.sh"]);
		expect(X.instrumentFiles("pytest -q tests/", t)).toEqual(["tests/"]);
		expect(X.instrumentFiles("cat work.txt", t)).toEqual([]);
		expect(X.instrumentFiles("wc -l < solve.py", t)).toEqual([]);
		expect(X.instrumentFiles("test -s work.txt", t)).toEqual([]);
	});

	test("slug and durations", () => {
		expect(X.slug("Make the API 2x faster!!", new Set())).toBe("g-make-the-api-2x");
		expect(X.slug("x", new Set(["g-x"]))).toBe("g-x-2");
		expect(X.parseDuration("30m")).toBe(1800);
		expect(X.parseDuration("90s")).toBe(90);
		expect(X.parseDuration("1h")).toBe(3600);
		expect(X.parseDuration("soon")).toBeUndefined();
	});
});

describe("pairs that already decide", () => {
	test("three pairs settle a clear gain or regression; a close call takes more", () => {
		const m = metric({ baseline: 100, noise: 0.05 });
		expect(X.settled(m, [[100, 50], [101, 52], [99, 49]])).toBe(true);
		expect(X.settled(m, [[100, 150], [101, 152], [99, 149]])).toBe(true);
		expect(X.settled(m, [[100, 97], [101, 103], [99, 95]])).toBe(false);
		expect(X.settled(m, [[100, 50], [101, 52]])).toBe(false);
		expect(X.settled(metric({ hold: true, noise: 0.2 }), [[100, 100], [101, 101], [99, 99.5]])).toBe(true);
	});
	test("pairs in two clusters (a side-biased jury) decide nothing; clusters along the A B / B A order are drift", () => {
		const sided = [0.4, 0.42, -0.4, 0.41, -0.38, -0.41, -0.39, 0.4];
		expect(X.twoModes(sided)).toBeDefined();
		const m = metric({ name: "pref", dir: "up", baseline: 50, target: 70 });
		const ps: [number, number][] = sided.map(g => [50, 50 * (1 + g)]);
		const v = X.pairedVerdict([m], { pref: ps });
		expect(v.kept).toBe(false);
		expect(v.regressed).toBe(false);
		expect(v.reason).toContain("lands in two clusters");
		// Linear drift under A B, B A alternates the sign with the order: pairing cancels it, it is no instrument fault.
		expect(X.twoModes([-0.1, 0.077, -0.071, 0.059, -0.056, 0.048])).toBeUndefined();
		expect(X.twoModes([0.05, 0.051, 0.049, 0.052, 0.05, 0.048])).toBeUndefined();
	});

	test("an instrument is judged by what the most pairs it may get would show, not by 3 (platinum's x2)", () => {
		const m = metric({ name: "pref", dir: "up", baseline: 50, target: 70 });
		const x2: [number, number][] = [[42, 53.8], [38.2, 47.8], [47.5, 42]];
		expect(X.pairedVerdict([m], { pref: x2 }).stats.pref.noise).toBeGreaterThan(0.6);
		expect(X.pairNoiseAt(m, x2)).toBeLessThan(0.35);
		expect(X.pairNoiseAt(m, x2)).toBeLessThan(L.gain(m, 50, 70));
	});
});

describe("what a command touches", () => {
	const root = "/r/repo";
	const ch = (cmd: string, cwd = root) => X.changesTree(cmd, root, cwd, "/home/u");
	test("tree-changing git verbs and writes into the checkout change it; reads and writes elsewhere do not", () => {
		for (const c of ["git commit -qam x", "git stash push src/a.ts", "git -C /r/repo checkout -- a", "echo 1 > a.txt", "cat x >> /r/repo/b", "rm -rf build/x", "sed -i '' s/a/b/ src/a.ts", "cp /tmp/p src/a.ts", "sudo mv a b", "cd src && tee out.txt"])
			expect([c, ch(c)]).toEqual([c, true]);
		for (const c of ["git log --oneline | head", "git status --short; git diff", "git stash list", "grep -rn x . > /tmp/found", "cat a.txt 2>/dev/null", "bun test 2>&1 | tail", "cp src/a.ts /tmp/a", "cd /tmp && echo 1 > a.txt", "git -C /other commit -m x", "python3 bench.py --out /tmp/r.json"])
			expect([c, ch(c)]).toEqual([c, false]);
		// Variables the command sets are expanded; a path it cannot place is not counted inside (voice's scratch copy was refused).
		const W = "/tmp/claude/scratchpad/wt";
		expect(ch(`W=${W}; rm -rf $W && mkdir -p $W && git -C /r/repo archive HEAD | tar -x -C $W && cd $W && ln -sf /r/repo/node_modules node_modules`)).toBe(false);
		expect(ch(`W=${W} && (git worktree add --detach $W HEAD || true) && cd $W && ln -sf /r/repo/.env .env`)).toBe(false);
		expect(ch("D=/r/repo/src; rm $D/a.ts")).toBe(true);
		expect(ch("export D=/r/repo; echo x > $D/a")).toBe(true);
		expect(ch("rm -rf $UNKNOWN/x")).toBe(false);
		// From another directory, relative writes land there.
		expect(ch("echo 1 > a.txt", "/tmp")).toBe(false);
		expect(ch("cd /r/repo && echo 1 > a.txt", "/tmp")).toBe(true);
	});
	test("the directory an instrument cds into, when every command agrees", () => {
		expect(X.cdInto(["cd /a/design && bash run.sh", "cd /a/design; python x.py"], "/h")).toBe("/a/design");
		expect(X.cdInto(["cd ~/dev/d && make"], "/h")).toBe("/h/dev/d");
		expect(X.cdInto(["cd /a && x", "cd /b && y"], "/h")).toBeUndefined();
		expect(X.cdInto(["bash run.sh"], "/h")).toBeUndefined();
		expect(X.cdInto(["cd src && make"], "/h")).toBeUndefined();
	});
});

describe("ledger fold", () => {
	const nowMs = Date.parse("2026-10-28T12:00:00Z");
	const base = (): L.Entry[] => [
		{ ts: iso(5e6, nowMs), kind: "goal", goal: "g", intent: "fast", cfg: { poke_max: 3, beat_s: 1800 } },
		{ ts: iso(4e6, nowMs), kind: "card", goal: "g", metrics: [metric()] },
	];

	test("review holds: a split goal without a card of its own, re-ask cards, unconfirmed meets", () => {
		const review = (goal: string, t: number): L.Entry => ({ ts: iso(t, nowMs), kind: "judge", goal, by: "judge", review: true, verdict: "continue", diagnosis: "Every part is achieved, but not the intent: no real call", next: "grade a real call" });
		const tree = L.fold([
			{ ts: iso(9e6, nowMs), kind: "goal", goal: "r", intent: "voice", cfg: { poke_max: 3, beat_s: 1800 } },
			{ ts: iso(8e6, nowMs), kind: "goal", goal: "a", parent: "r", intent: "a", cfg: { poke_max: 3, beat_s: 1800 } },
			{ ts: iso(8e6, nowMs), kind: "goal", goal: "b", parent: "r", intent: "b", cfg: { poke_max: 3, beat_s: 1800 } },
			{ ts: iso(7e6, nowMs), kind: "done", goal: "a", result: "achieved", values: {} },
			{ ts: iso(6e6, nowMs), kind: "done", goal: "b", result: "achieved", values: {} },
			review("r", 5e6),
		]);
		const next = X.nextAction(tree, tree.goals.get("r")!);
		expect(next).toContain("Every part is achieved, yet the goal is not achieved. The acceptance review: no real call → grade a real call.");
		expect(next).not.toContain("Researching");
		expect(X.report(tree, nowMs)).toContain("held by the acceptance review");
		// A re-ask card keeps the hold (a crash mid-review can ask again); any other card ends it.
		const held = (card: Partial<L.CardE>) => L.fold([...base(), review("g", 3.5e6), { ts: iso(3e6, nowMs), kind: "card", goal: "g", metrics: [metric()], ...card } as L.Entry]).goals.get("g")!.reviewed;
		expect(held({ reask: true })).toBeDefined();
		expect(held({})).toBeUndefined();
		// Targets met once and not confirmed: the same checks on a scorecard confirm it (or re-baseline a lucky draw).
		const once = L.fold([
			...base(),
			{ ts: iso(3e6, nowMs), kind: "exp", goal: "g", id: "x1", lever: "c", hypothesis: "", prediction: "", base: "a", ref: { ms: 100 } },
			{ ts: iso(2e6, nowMs), kind: "result", goal: "g", exp: "x1", head: "b", values: { ms: 8 }, verdict: "kept", reason: "" },
		]);
		expect(X.nextAction(once, once.goals.get("g")!)).toContain("Every target is met, yet g is not closed");
		expect(X.nextAction(once, once.goals.get("g")!)).toContain("climb_scorecard with the same checks");
	});

	test("a part with every target met but not closed comes next, however deep it waits", () => {
		const goal = (id: string, parent?: string): L.Entry => ({ ts: iso(9e6, nowMs), kind: "goal", goal: id, parent, intent: id, cfg: { poke_max: 3, beat_s: 1800 } });
		const st = L.fold([
			goal("r"),
			goal("a", "r"),
			goal("b", "r"),
			goal("a1", "a"),
			goal("a2", "a"),
			{ ts: iso(4e6, nowMs), kind: "card", goal: "a1", metrics: [metric()] },
			{ ts: iso(3e6, nowMs), kind: "exp", goal: "a1", id: "x1", lever: "c", hypothesis: "", prediction: "", base: "a", ref: { ms: 100 } },
			{ ts: iso(2e6, nowMs), kind: "result", goal: "a1", exp: "x1", head: "b", values: { ms: 8 }, verdict: "kept", reason: "" },
		]);
		expect(X.nextAction(st, st.goals.get("r")!)).toContain("Next, a1: [climb a1] Every target is met, yet a1 is not closed");
	});

	test("after a drop the router stays on the part being climbed, until its drop streak blocks it", () => {
		const goal = (id: string, parent?: string): L.Entry => ({ ts: iso(9e6, nowMs), kind: "goal", goal: id, parent, intent: id, cfg: { poke_max: 3, beat_s: 1800 } });
		const drop = (n: number): L.Entry[] => [
			{ ts: iso(3e6 - n, nowMs), kind: "exp", goal: "fast", id: `x${n}`, lever: `l${n}`, hypothesis: "", prediction: "", base: "a", ref: { ms: 100 } },
			{ ts: iso(2e6 - n, nowMs), kind: "result", goal: "fast", exp: `x${n}`, head: "b", values: { ms: 100 }, verdict: "dropped", reason: "within noise" },
		];
		const base: L.Entry[] = [
			goal("r"),
			goal("good", "r"),
			goal("fast", "r"),
			{ ts: iso(5e6, nowMs), kind: "card", goal: "good", metrics: [metric({ baseline: 100, target: 10 })] },
			{ ts: iso(4e6, nowMs), kind: "card", goal: "fast", metrics: [metric({ baseline: 100, target: 10 })] },
		];
		const next = (e: L.Entry[]) => { const st = L.fold(e); return X.nextAction(st, st.goals.get("r")!); };
		expect(next([...base, ...drop(1)])).toContain("Next, fast:");
		expect(next([...base, ...drop(1), ...drop(2), ...drop(3)])).toContain("Next, good:");
	});

	test("a judge's PIVOT after an experiment opened travels with every nudge to finish it", () => {
		const exp: L.Entry = { ts: iso(3e6, nowMs), kind: "exp", goal: "g", id: "x1", lever: "c", hypothesis: "h", prediction: "", base: "a", ref: { ms: 100 } };
		const judge = (t: number): L.Entry => ({ ts: iso(t, nowMs), kind: "judge", goal: "g", by: "judge", verdict: "pivot", diagnosis: "same idea", next: "trace one request end to end." });
		const after = L.fold([...base(), exp, judge(2e6)]);
		expect(X.nextAction(after, after.goals.get("g")!)).toContain("The judge said PIVOT after x1 opened: trace one request end to end. If x1 is not that");
		const before = L.fold([...base(), judge(3.5e6), exp]);
		expect(X.nextAction(before, before.goals.get("g")!)).not.toContain("PIVOT");
	});

	test("a researching part as deep as parts go is pointed beside it, not at a split it cannot make", () => {
		const goal = (id: string, parent?: string): L.Entry => ({ ts: iso(9e6, nowMs), kind: "goal", goal: id, parent, intent: id, cfg: { poke_max: 3, beat_s: 1800 } });
		const st = L.fold([goal("r"), goal("a", "r"), goal("a1", "a"), goal("b", "r")]);
		expect(X.nextAction(st, st.goals.get("a1")!)).toContain("It is as deep as parts go: what one scorecard cannot hold goes in a part beside it (climb_split on a).");
		expect(X.nextAction(st, st.goals.get("b")!)).toContain("split it into parts with climb_split");
	});

	test("a target met from the start (a review re-ask card) reads 100%, never negative", () => {
		expect(X.progressPct(metric({ dir: "up", baseline: 13, target: 10 }), 16)).toBe(100);
		expect(X.progressPct(metric({ dir: "up", baseline: 13, target: 10 }), 9)).toBe(0);
		expect(X.progressPct(metric({ dir: "down", baseline: 100, target: 10 }), 55)).toBe(50);
		expect(X.progressPct(metric({ dir: "down", baseline: 4581, target: 0 }), 2)).toBe(99);
		expect(X.progressPct(metric({ dir: "down", baseline: 4581, target: 0 }), 0)).toBe(100);
		const goal = (id: string, parent?: string): L.Entry => ({ ts: iso(9e6, nowMs), kind: "goal", goal: id, parent, intent: id, cfg: { poke_max: 3, beat_s: 1800 } });
		const st = L.fold([
			goal("r"),
			goal("a", "r"),
			goal("b", "r"),
			{ ts: iso(5e6, nowMs), kind: "done", goal: "a", result: "achieved", values: {} },
			{ ts: iso(4e6, nowMs), kind: "card", goal: "b", metrics: [metric({ baseline: 4581, target: 0 })] },
			{ ts: iso(3e6, nowMs), kind: "exp", goal: "b", id: "x1", lever: "c", hypothesis: "", prediction: "", base: "a", ref: { ms: 4581 } },
			{ ts: iso(2e6, nowMs), kind: "result", goal: "b", exp: "x1", head: "h", values: { ms: 2 }, verdict: "kept", reason: "" },
		]);
		expect(X.goalPct(st, st.goals.get("r")!)).toBe(99);
	});

	test("a part achieved since the last beat is progress for the tree", () => {
		const entries: L.Entry[] = [
			{ ts: iso(9e6, nowMs), kind: "goal", goal: "r", intent: "voice", cfg: { poke_max: 3, beat_s: 1800 } },
			{ ts: iso(8e6, nowMs), kind: "goal", goal: "a", parent: "r", intent: "a", cfg: { poke_max: 3, beat_s: 1800 } },
			{ ts: iso(8e6, nowMs), kind: "goal", goal: "b", parent: "r", intent: "b", cfg: { poke_max: 3, beat_s: 1800 } },
			{ ts: iso(7e6, nowMs), kind: "beat", goal: "r", head: "h", progress: false, stale: 0 },
		];
		const r = (e: L.Entry[]) => { const s = L.fold(e); return L.treeProgressSinceBeat(s, s.goals.get("r")!); };
		expect(r(entries)).toBe(false);
		expect(r([...entries, { ts: iso(6e6, nowMs), kind: "done", goal: "a", result: "achieved", values: {} }])).toBe(true);
		expect(r([...entries, { ts: iso(6e6, nowMs), kind: "done", goal: "a", result: "abandoned", values: {} }])).toBe(false);
	});

	test("research that lands a part's first scorecard within a beat is progress; a re-baseline is not", () => {
		const entries: L.Entry[] = [
			{ ts: iso(9e6, nowMs), kind: "goal", goal: "r", intent: "voice", cfg: { poke_max: 3, beat_s: 1800 } },
			{ ts: iso(8e6, nowMs), kind: "goal", goal: "a", parent: "r", intent: "a", cfg: { poke_max: 3, beat_s: 1800 } },
			{ ts: iso(7e6, nowMs), kind: "beat", goal: "r", head: "h", progress: false, stale: 1 },
			{ ts: iso(6e6, nowMs), kind: "probe", goal: "a", name: "ms", cmd: "echo 1", value: 1 },
			{ ts: iso(5e6, nowMs), kind: "card", goal: "a", metrics: [metric()] },
		];
		const r = (e: L.Entry[]) => { const s = L.fold(e); return L.treeProgressSinceBeat(s, s.goals.get("r")!); };
		expect(r(entries)).toBe(true);
		const later: L.Entry[] = [...entries, { ts: iso(4e6, nowMs), kind: "beat", goal: "r", head: "h", progress: true, stale: 0 }];
		expect(r(later)).toBe(false);
		expect(r([...later, { ts: iso(3e6, nowMs), kind: "card", goal: "a", metrics: [metric({ baseline: 90 })] }])).toBe(false);
	});

	test("a later card keeps each metric's first baseline while its command is unchanged", () => {
		const st = L.fold([
			...base(),
			{ ts: iso(3e6, nowMs), kind: "card", goal: "g", metrics: [metric({ baseline: 40, hold: true }), metric({ name: "other", baseline: 7 })] },
			{ ts: iso(2e6, nowMs), kind: "card", goal: "g", metrics: [metric({ baseline: 30 }), metric({ name: "other", cmd: "echo 2", baseline: 5 })] },
		]);
		const g = st.goals.get("g")!;
		expect(g.origin).toEqual({ ms: { value: 100, cmd: "echo 1" }, other: { value: 5, cmd: "echo 2" } });
	});

	test("results move best, open experiment closes, levers count", () => {
		const st = L.fold([
			...base(),
			{ ts: iso(3e6, nowMs), kind: "exp", goal: "g", id: "x1", lever: "Cache", hypothesis: "", prediction: "", base: "a", ref: { ms: 100 } },
			{ ts: iso(2e6, nowMs), kind: "result", goal: "g", exp: "x1", head: "b", values: { ms: 60 }, verdict: "kept", reason: "" },
			{ ts: iso(1e6, nowMs), kind: "exp", goal: "g", id: "x2", lever: "cache ", hypothesis: "", prediction: "", base: "b", ref: { ms: 60 } },
		]);
		const g = st.goals.get("g")!;
		expect(g.best.ms).toBe(60);
		expect(g.open?.id).toBe("x2");
		expect(g.nextExp).toBe(3);
		expect(g.levers.get("cache")).toMatchObject({ tried: 1, kept: 1 });
	});

	test("stall is pending until a judge answers; stuck clears on later progress", () => {
		const entries: L.Entry[] = [
			...base(),
			{ ts: iso(3e6, nowMs), kind: "stall", goal: "g", stale: 3 },
		];
		expect(L.fold(entries).goals.get("g")!.stallPending).toBe(true);
		entries.push({ ts: iso(2e6, nowMs), kind: "judge", goal: "g", by: "judge", verdict: "stuck", diagnosis: "", next: "" });
		let g = L.fold(entries).goals.get("g")!;
		expect(g.stallPending).toBe(false);
		expect(L.stuck(g)).toBe(true);
		entries.push({ ts: iso(1e6, nowMs), kind: "beat", goal: "g", head: "c", values: { ms: 40 }, progress: true, stale: 0 });
		g = L.fold(entries).goals.get("g")!;
		expect(L.stuck(g)).toBe(false);
	});

	test("a stuck goal rests only itself: a tree with a workable part still climbs, a lone stuck leaf does not", () => {
		const goal = (id: string, parent?: string): L.Entry => ({ ts: iso(9e6, nowMs), kind: "goal", goal: id, parent, intent: id, cfg: { poke_max: 3, beat_s: 1800 } });
		// Root r split into parts a and b; the judge calls the root STUCK because one part needs the human.
		const st = L.fold([goal("r"), goal("a", "r"), goal("b", "r"), { ts: iso(3e6, nowMs), kind: "judge", goal: "r", by: "judge", verdict: "stuck", diagnosis: "part b needs a credential", next: "provide the API credential" }]);
		const r = st.goals.get("r")!;
		expect(L.stuck(r)).toBe(true); // the root is flagged STUCK
		expect(L.canClimb(st, r)).toBe(true); // but its parts are workable, so the tree still climbs
		expect(L.workable(st, st.goals.get("a")!)).toBe(true);
		expect(L.workable(st, r)).toBe(false); // an umbrella is climbed only through its parts
		// The status line says it is still climbing, not that the whole thing is parked.
		expect(X.statusLine(st, nowMs)).toContain("climbing the rest");
		// A lone stuck leaf with nothing else rests: nothing in it is workable.
		const solo = L.fold([goal("s"), { ts: iso(3e6, nowMs), kind: "judge", goal: "s", by: "judge", verdict: "stuck", diagnosis: "", next: "ask" }]);
		expect(L.canClimb(solo, solo.goals.get("s")!)).toBe(false);
	});

	test("a STUCK verdict holds until something moves after it: research from before it is no progress at the next beat", () => {
		const fresh = (): L.Entry[] => [
			{ ts: iso(5e6, nowMs), kind: "goal", goal: "g", intent: "fast", cfg: { poke_max: 3, beat_s: 1800 } },
			{ ts: iso(4.5e6, nowMs), kind: "beat", goal: "g", head: "c", progress: false, stale: 1 },
			{ ts: iso(4e6, nowMs), kind: "probe", goal: "g", name: "jury", cmd: "x", value: 6.9 },
			{ ts: iso(3e6, nowMs), kind: "judge", goal: "g", by: "judge", verdict: "stuck", diagnosis: "the operator must act", next: "ask" },
		];
		const st = L.fold(fresh());
		expect(L.stuck(st.goals.get("g")!)).toBe(true);
		expect(L.treeProgressSinceBeat(st, st.goals.get("g")!)).toBe(false);
		const later = L.fold([...fresh(), { ts: iso(2e6, nowMs), kind: "probe", goal: "g", name: "jury2", cmd: "y", value: 7.1 }]);
		expect(L.treeProgressSinceBeat(later, later.goals.get("g")!)).toBe(true);
	});

	test("a moved goal is no longer active where it left", () => {
		const st = L.fold([...base(), { ts: iso(1e6, nowMs), kind: "moved", goal: "g", to: "/elsewhere" }]);
		expect(L.active(st)).toHaveLength(0);
		expect(st.goals.get("g")!.moved).toBe("/elsewhere");
	});

	test("three drops in a row on any levers block until a judge; a kept result resets", () => {
		const entries: L.Entry[] = [...base()];
		const drop = (i: number, lever: string) =>
			entries.push(
				{ ts: iso(4e6 - i * 1e5, nowMs), kind: "exp", goal: "g", id: `x${i}`, lever, hypothesis: "", prediction: "", base: "a", ref: { ms: 100 } },
				{ ts: iso(4e6 - i * 1e5 - 5e4, nowMs), kind: "result", goal: "g", exp: `x${i}`, head: "b", values: { ms: 100 }, verdict: "dropped", reason: "" },
			);
		drop(1, "tweak");
		drop(2, "tweak2");
		expect(X.streakBlocked(L.fold(entries).goals.get("g")!)).toBeUndefined();
		drop(3, "other");
		expect(X.streakBlocked(L.fold(entries).goals.get("g")!)).toContain("3 experiments dropped in a row");
		entries.push({ ts: iso(1e5, nowMs), kind: "judge", goal: "g", by: "worker", verdict: "pivot", diagnosis: "", next: "" });
		expect(X.streakBlocked(L.fold(entries).goals.get("g")!)).toContain("in a row"); // self-grading does not clear it
		entries.push({ ts: iso(5e4, nowMs), kind: "judge", goal: "g", by: "judge", verdict: "pivot", diagnosis: "", next: "" });
		expect(X.streakBlocked(L.fold(entries).goals.get("g")!)).toBeUndefined();
	});

	test("only kept results ratchet best; heartbeat draws do not", () => {
		const st = L.fold([
			...base(),
			{ ts: iso(3e6, nowMs), kind: "beat", goal: "g", head: "h", values: { ms: 20 }, progress: true, stale: 0 },
		]);
		const g = st.goals.get("g")!;
		expect(g.best.ms).toBe(100);
		expect(g.series.get("ms")!.map(p => p.v)).toEqual([100, 20]);
	});
});

describe("compaction", () => {
	const nowMs = Date.parse("2026-10-28T12:00:00Z");
	const ledger = (): L.Entry[] => {
		const e: L.Entry[] = [
			{ ts: iso(61 * 86_400_000, nowMs), kind: "goal", goal: "g", intent: "x", cfg: { poke_max: 3, beat_s: 1800 } },
			{ ts: iso(61 * 86_400_000 - 1000, nowMs), kind: "card", goal: "g", metrics: [metric()] },
		];
		for (let i = 60 * 48; i > 0; i--) {
			const ts = iso(i * 1_800_000, nowMs);
			e.push({ ts, kind: "beat", goal: "g", head: "h", values: { ms: 10 + i / 100 }, progress: i % 7 === 0, stale: i % 3 });
			if (i % 500 === 0) e.push({ ts, kind: "judge", goal: "g", by: "judge", verdict: "continue", diagnosis: "d", next: "n" });
		}
		return e;
	};

	test("rolls beats into hour/day/month, keeps decisions, converges in one call", () => {
		const before = ledger();
		const after = L.compact(before, nowMs);
		expect(after.length).toBeLessThan(before.length / 10);
		const kinds = (es: L.Entry[], k: string) => es.filter(x => x.kind === k).length;
		expect(kinds(after, "judge")).toBe(kinds(before, "judge"));
		expect(kinds(after, "goal") + kinds(after, "card")).toBe(2);
		expect(after.filter(x => x.kind === "rollup").map(x => (x as L.RollupE).cd).sort()).toContain(3);
		expect(L.compact(after, nowMs)).toEqual(after);
		// chronological order survives
		for (let i = 1; i < after.length; i++) expect(after[i].ts >= after[i - 1].ts).toBe(true);
		// total beat count survives in rollups
		const n = after.reduce((s, x) => s + (x.kind === "beat" ? 1 : x.kind === "rollup" ? x.n : 0), 0);
		expect(n).toBe(kinds(before, "beat"));
	});

	test("fold sees the same best and goal state after compaction", () => {
		const before = L.fold(ledger()).goals.get("g")!;
		const after = L.fold(L.compact(ledger(), nowMs)).goals.get("g")!;
		expect(after.best).toEqual(before.best);
		expect(after.lastBeat?.stale).toBe(before.lastBeat?.stale);
		expect(after.judge?.ts).toBe(before.judge?.ts);
	});
});

describe("acceptance review", () => {
	test("parses the reviewer's verdict; only an explicit unmet holds the goal open", () => {
		expect(X.parseReview("**VERDICT:** unmet\nUNMET: the unicode bug was never checked\nNEXT: add a part for it")).toEqual({ achieved: false, unmet: "the unicode bug was never checked", next: "add a part for it" });
		expect(X.parseReview("VERDICT: achieved\nUNMET: none\nNEXT: stop").achieved).toBe(true);
		expect(X.parseReview("garbled").achieved).toBe(true);
		for (const v of ["`unmet`", "[unmet]", "not achieved", "Unmet."]) expect(X.parseReview(`VERDICT: ${v}\nUNMET: x\nNEXT: y`).achieved).toBe(false);
		expect(X.parseReview("VERDICT: **achieved**\nUNMET: none").achieved).toBe(true);
	});
});

describe("paired verdict", () => {
	test("pairs decide the uncertain metrics; the sure ones keep their plain comparison", () => {
		const ms = metric({ name: "ms", noise: 0.3 });
		const err = metric({ name: "err", noise: 0.05 });
		// ms drifted: plainly -40%, but paired back to back it is +20% every time.
		const pairs = { ms: [[100, 80], [130, 104], [160, 128]] as [number, number][] };
		const v = X.pairedVerdict([ms, err], pairs, { ref: { ms: 100, err: 10 }, values: { ms: 140, err: 10 } });
		expect(v.kept).toBe(true);
		expect(v.reason).toContain("3 pairs for ms");
		expect(v.stats.err).toMatchObject({ gain: 0, n: 0 });
		const worse = X.pairedVerdict([ms, err], pairs, { ref: { ms: 100, err: 10 }, values: { ms: 140, err: 20 } });
		expect(worse).toMatchObject({ kept: false, regressed: true });
		expect(worse.reason).toContain("err -100.0% ±5.0% (unpaired)");
	});
});

describe("efficiency summary", () => {
	test("reports guard cost next to metric runs", () => {
		const now = Date.parse("2026-10-29T12:00:00Z");
		const ts = (m: number) => new Date(now - m * 60_000).toISOString();
		const traces: T.Trace[] = [
			{ ts: ts(30), kind: "run", phase: "guard", goal: "g", ms: 67_000, code: 0 },
			{ ts: ts(20), kind: "run", phase: "guard", goal: "g", ms: 4_700, code: 0 },
			{ ts: ts(20), kind: "run", phase: "guard", goal: "g", ms: 5_100, code: 1 },
			{ ts: ts(19), kind: "run", phase: "result", goal: "g", metric: "ms", ms: 1_000, code: 0, value: 10 },
			{ ts: ts(18), kind: "tool", goal: "g", tool: "climb_measure", ms: 8_000, ok: true },
		];
		const s = T.stats(traces, [], now);
		expect(s).toContain("guard 3× (median 5s, 1 failed)");
		expect(s).toContain("climb tools 8s");
	});
});
