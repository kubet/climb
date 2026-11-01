// The ledger: .climb/oracle.jsonl. Append-only, owned by the extension. Only
// heartbeats are ever compacted; decisions (goals, cards, experiments, results,
// judges) are kept forever.
import * as fs from "node:fs";
import * as path from "node:path";

export type Dir = "up" | "down";
export type Values = Record<string, number>;
export type Verdict = "continue" | "pivot" | "stuck";

export interface Metric {
	name: string;
	cmd: string;
	dir: Dir;
	baseline: number;
	target: number;
	unit?: string;
	/** Relative change below which a difference is noise. */
	noise: number;
	samples: number;
	timeout_s: number;
	/** A constraint, not a goal: must not regress beyond noise; target = baseline. */
	hold?: boolean;
	/** Base and candidate may run at the same time in a pair: the command takes its port (or other exclusive
	 *  resource) from $CLIMB_SLOT, 0 for the candidate and 1 for the base. */
	parallel?: boolean | number;
}

export interface Cfg {
	poke_max: number;
	beat_s: number;
}

interface Base {
	ts: string;
	goal: string;
}
/** A goal; with `parent`, a part of a decomposed goal (its own research, scorecard and experiments). */
export interface GoalE extends Base { kind: "goal"; intent: string; cfg: Cfg; parent?: string; why?: string; harness?: string }
export interface CardE extends Base {
	kind: "card";
	metrics: Metric[];
	guard?: string;
	/** Instrument paths (globs) an experiment may not touch. */
	frozen?: string[];
	/** Commit the baselines were measured on. */
	head?: string;
	parked?: string[];
	axioms?: string[];
	/** Hash of what measures: metric commands, guard, and the frozen files' contents at `head`. */
	instrument?: string;
	/** The machine the baselines were measured on. */
	env?: Env;
	/** Passing checks put to the acceptance review again: the hold it answers stands until the review does. */
	reask?: true;
}
export interface Env { host: string; os: string; arch: string; cpus: number; cpu: string; mem_gb: number; runtime: string; harness?: string; hash: string }
/** How each gate came out, so a result can be audited without parsing its reason. */
export interface Gates { guard: "pass" | "fail" | "none"; instrument: "same" | "changed"; proof?: "pass" | "fail" | "void" }
/** A check that failed at the base and must pass once the change works, with the
 *  content hashes of the scripts it runs (edited scripts void it). */
export interface Proof {
	cmd: string;
	files: Record<string, string>;
	/** Its slowest run at registration: a run far longer than that at measurement has hung. */
	ms?: number;
}
export interface ExpE extends Base {
	kind: "exp";
	id: string;
	lever: string;
	hypothesis: string;
	prediction: string;
	base: string;
	ref: Values;
	proof?: Proof;
	/** The control's raw runs per metric (ref holds their medians). */
	runs?: Record<string, number[]>;
	/** Env hash at registration. */
	env?: string;
}
export interface ResultE extends Base {
	kind: "result";
	exp: string;
	head: string;
	values: Values;
	verdict: "kept" | "dropped";
	reason: string;
	reverted?: string;
	/** Kept on its proof: a verified fix with no regression, not a measured gain. */
	proof?: boolean;
	/** The candidate's raw runs per metric (values holds their medians). */
	runs?: Record<string, number[]>;
	/** When decided on interleaved base/candidate pairs: [base, candidate] per pair, per metric. */
	paired?: Record<string, [number, number][]>;
	/** A streak of proof keeps was measured in pairs against this commit, where it started, and held. */
	checked?: string;
	gates?: Gates;
	/** Env hash at measurement. */
	env?: string;
}
export interface BeatE extends Base { kind: "beat"; head: string; values?: Values; progress: boolean; stale: number; note?: string }
export interface StallE extends Base { kind: "stall"; stale: number }
/** A research item: a candidate metric the extension ran during research. */
export interface ProbeE extends Base { kind: "probe"; name: string; cmd: string; value?: number; error?: string; note?: string }
export interface JudgeE extends Base { kind: "judge"; by: "judge" | "worker" | "human" | "fallback"; verdict: Verdict; diagnosis: string; next: string; /** the acceptance review held the goal open */ review?: true }
export interface DoneE extends Base {
	kind: "done";
	result: "achieved" | "abandoned";
	values: Values;
	/** Achieved without the acceptance review, and why it did not run. */
	unreviewed?: string;
	/** Why it was abandoned, when not by the user's /climb done (a new goal superseded it). */
	why?: string;
}
export interface PauseE extends Base { kind: "pause" | "resume" }
export interface RollupE extends Base { kind: "rollup"; cd: number; n: number; from: string; to: string; progress: number; stale: number; values?: Values }
/** Knowledge: a fact about the system or instrument, a trap (X looks like Y; check Z), or a dead end. */
export type LearnKind = "fact" | "trap" | "dead-end";
export interface LearnE extends Base { kind: "learn"; type: LearnKind; text: string; evidence?: string }

/** The goal climbs in another checkout from here on (its instrument lives there, or this one is shared and dirty). */
export interface MovedE extends Base { kind: "moved"; to: string }

export type Entry = GoalE | CardE | ExpE | ResultE | BeatE | StallE | ProbeE | JudgeE | DoneE | PauseE | RollupE | LearnE | MovedE;

export interface Point {
	t: number;
	v: number;
}

export interface Goal {
	id: string;
	intent: string;
	/** Set on a part of a decomposed goal. */
	parent?: string;
	why?: string;
	/** Parts this goal was split into (ids, creation order). */
	children: string[];
	learned: LearnE[];
	cfg: Cfg;
	created: string;
	card?: CardE;
	best: Values;
	open?: ExpE;
	results: ResultE[];
	levers: Map<string, { tried: number; kept: number; dropped: number }>;
	/** Consecutive drops (any lever) since the last kept result or independent verdict. */
	streak: number;
	/** Commit whose tree is the measured baseline, and the values measured there. */
	baseRef?: string;
	baseValues?: Values;
	lastBeat?: { ts: string; head: string; stale: number; seq: number };
	stallPending: boolean;
	/** Latest independent verdict (the judge or a human). */
	judge?: JudgeE;
	/** Latest diagnosis from anyone, the worker included (display only). */
	diagnosis?: JudgeE;
	/** Each metric's first baseline on this goal (while its command is unchanged): a later card still shows the whole climb. */
	origin?: Record<string, { value: number; cmd: string }>;
	/** The acceptance review held this goal open since its current card: its met targets did not finish the intent. */
	reviewed?: JudgeE;
	/** Ledger line of the latest independent verdict; line order never ties, timestamps can. */
	judgeSeq: number;
	lastKeptSeq: number;
	lastProgress?: string;
	progressSeq: number;
	/** Itemized research: every candidate metric probed, measured by the extension. */
	probes: ProbeE[];
	lastProbeSeq: number;
	/** Ledger line of the goal's first scorecard: the research it closes counts as progress. */
	firstCardSeq: number;
	/** Ledger line of the latest work on this goal itself (probe, scorecard, experiment, result). */
	workSeq: number;
	seq: number;
	done?: DoneE;
	/** The checkout this goal moved to: it is no longer climbed here. */
	moved?: string;
	/** Not from the ledger: paths its instrument names that are gone (a deleted scratchpad), set when it is loaded. */
	gone?: string[];
	series: Map<string, Point[]>;
	nextExp: number;
}

export interface State {
	goals: Map<string, Goal>;
	paused: boolean;
	lines: number;
}

export const DIR = ".climb";
export const FILE = "oracle.jsonl";
export const ledgerPath = (root: string) => path.join(root, DIR, FILE);
/** Swappable time source so tests can move the heartbeat clock. */
export const clock = { ms: () => Date.now() };
export const now = () => new Date(clock.ms()).toISOString();
export const epoch = (ts: string) => Date.parse(ts);
export const lever = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");

export const better = (dir: Dir, a: number, b: number) => (dir === "down" ? a < b : a > b);
export const met = (m: Metric, v: number | undefined): boolean =>
	v !== undefined && (m.hold ? gain(m, m.baseline, v) >= -m.noise : m.dir === "down" ? v <= m.target : v >= m.target);

export function read(root: string): Entry[] {
	let text: string;
	try {
		text = fs.readFileSync(ledgerPath(root), "utf8");
	} catch {
		return [];
	}
	const out: Entry[] = [];
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		try {
			out.push(JSON.parse(line));
		} catch {
			// a torn final line from a crash mid-append; skip it
		}
	}
	return out;
}

export function append(root: string, ...entries: Entry[]): void {
	fs.mkdirSync(path.join(root, DIR), { recursive: true });
	fs.appendFileSync(ledgerPath(root), entries.map(e => JSON.stringify(e)).join("\n") + "\n");
}

function newGoal(e: GoalE): Goal {
	return {
		id: e.goal,
		intent: e.intent,
		parent: e.parent,
		why: e.why,
		children: [],
		learned: [],
		cfg: e.cfg,
		created: e.ts,
		best: {},
		results: [],
		levers: new Map(),
		stallPending: false,
		streak: 0,
		judgeSeq: -1,
		lastKeptSeq: -1,
		progressSeq: -1,
		probes: [],
		lastProbeSeq: -1,
		firstCardSeq: -1,
		workSeq: -1,
		seq: -1,
		series: new Map(),
		nextExp: 1,
	};
}

/** Relative gain of `v` over `ref` in the metric's good direction (+ = better). */
export function gain(m: Metric, ref: number, v: number): number {
	const d = m.dir === "down" ? ref - v : v - ref;
	return d / (Math.abs(ref) || 1);
}

// Only kept results (and the baseline) move `best`: a heartbeat's single lucky
// draw must never become the bar every later experiment is judged against.
function record(g: Goal, ts: string, values: Values | undefined, ratchet: boolean): void {
	if (!values || !g.card) return;
	for (const m of g.card.metrics) {
		const v = values[m.name];
		if (v === undefined) continue;
		const pts = g.series.get(m.name) ?? [];
		pts.push({ t: epoch(ts), v });
		g.series.set(m.name, pts);
		const b = g.best[m.name];
		if (ratchet && (b === undefined || better(m.dir, v, b))) g.best[m.name] = v;
	}
}

export function fold(entries: Entry[]): State {
	const st: State = { goals: new Map(), paused: false, lines: entries.length };
	const exps = new Map<string, ExpE>();
	for (const [seq, e] of entries.entries()) {
		if (e.kind === "pause") { st.paused = true; continue; }
		if (e.kind === "resume") { st.paused = false; continue; }
		if (e.kind === "goal") {
			st.goals.set(e.goal, { ...newGoal(e), seq });
			if (e.parent) st.goals.get(e.parent)?.children.push(e.goal);
			continue;
		}
		const g = st.goals.get(e.goal);
		if (!g) continue;
		if (e.kind === "probe" || e.kind === "card" || e.kind === "exp" || e.kind === "result") g.workSeq = seq;
		switch (e.kind) {
			case "card":
				if (!g.card) g.firstCardSeq = seq;
				g.card = e;
				if (!e.reask) g.reviewed = undefined;
				g.origin ??= {};
				for (const m of e.metrics) if (g.origin[m.name]?.cmd !== m.cmd) g.origin[m.name] = { value: m.baseline, cmd: m.cmd };
				g.baseRef = e.head;
				g.baseValues = Object.fromEntries(e.metrics.map(m => [m.name, m.baseline]));
				g.best = {};
				g.series = new Map();
				record(g, e.ts, Object.fromEntries(e.metrics.map(m => [m.name, m.baseline])), true);
				break;
			case "exp":
				g.open = e;
				exps.set(`${e.goal}|${e.id}`, e);
				g.nextExp = Math.max(g.nextExp, Number(e.id.replace(/\D/g, "")) + 1);
				break;
			case "result": {
				if (g.open?.id === e.exp) g.open = undefined;
				g.results.push(e);
				const exp = exps.get(`${e.goal}|${e.exp}`);
				const key = lever(exp?.lever ?? e.exp);
				// Kept: the experiment head is the new baseline. Dropped: the revert restored
				// the base tree; if the revert failed, HEAD will not match and climbing halts.
				g.baseRef = e.verdict === "kept" ? e.head : (e.reverted ?? exp?.base ?? g.baseRef);
				g.baseValues = e.verdict === "kept" ? e.values : (exp?.ref ?? g.baseValues);
				// Abandoned = never measured: not an attempt of the lever, not a step in a drop streak.
				const abandoned = e.reason.startsWith("abandoned:");
				const l = { ...(g.levers.get(key) ?? { tried: 0, kept: 0, dropped: 0 }) };
				l.tried++;
				if (e.verdict === "kept") {
					l.kept++;
					g.streak = 0;
					// A proven fix is kept, but values within noise neither ratchet `best` nor count
					// as progress: if the scorecard never moves, the heartbeat still calls the judge.
					record(g, e.ts, e.values, !e.proof);
					if (!e.proof) {
						g.lastProgress = e.ts;
						g.progressSeq = g.lastKeptSeq = seq;
					}
				} else {
					l.dropped++;
					if (!abandoned) g.streak++;
				}
				if (!abandoned) g.levers.set(key, l);
				break;
			}
			case "beat":
			case "rollup":
				g.lastBeat = { ts: e.kind === "rollup" ? e.to : e.ts, head: e.kind === "beat" ? e.head : "", stale: e.stale, seq };
				record(g, e.ts, e.values, false);
				if (e.kind === "beat" && e.progress) {
					g.lastProgress = e.ts;
					g.progressSeq = seq;
				}
				break;
			case "stall":
				g.stallPending = true;
				break;
			case "probe":
				g.probes.push(e);
				if (e.value !== undefined) g.lastProbeSeq = seq;
				break;
			case "judge":
				g.diagnosis = e;
				// An acceptance review that holds a goal is not a stall verdict: the worker can ask for one, so it
				// must not release a stall, reset the drop streak or clear STUCK. (Older ledgers say so in the diagnosis.)
				if (e.review || (e.by === "judge" && /^Every (target is met|part is achieved), but not the intent/.test(e.diagnosis))) {
					g.reviewed = e;
					break;
				}
				// A worker grading its own work is recorded but never releases a stall, resets the
				// stale count or opens the grid-search gate: only an independent verdict does.
				// ("fallback" is a worker diagnosis accepted because the host has no independent judge.)
				if (e.by === "worker") break;
				g.stallPending = false;
				g.judge = e;
				g.judgeSeq = seq;
				g.streak = 0;
				break;
			case "done":
				g.done = e;
				// Achieving a goal is progress, even when no experiment was kept for it (a verification scorecard).
				if (e.result === "achieved") {
					g.lastProgress = e.ts;
					g.progressSeq = g.lastKeptSeq = seq;
				}
				break;
			case "learn":
				g.learned.push(e);
				break;
			case "moved":
				g.moved = e.to;
				break;
		}
	}
	return st;
}

export const active = (st: State) => [...st.goals.values()].filter(g => !g.done && !g.moved);

// --- decomposition: a goal can be split into parts, each a goal with its own scorecard ---
export const parts = (st: State, g: Goal): Goal[] => g.children.map(id => st.goals.get(id)).filter((c): c is Goal => !!c);
export const openParts = (st: State, g: Goal) => parts(st, g).filter(c => !c.done);
/** A goal with open parts climbs only through them. */
export const umbrella = (st: State, g: Goal) => openParts(st, g).length > 0;
export const rootOf = (st: State, g: Goal): Goal => {
	let r = g;
	for (let i = 0; r.parent && i < 8; i++) r = st.goals.get(r.parent) ?? r;
	return r;
};
export const depth = (st: State, g: Goal) => {
	let n = 0;
	for (let r = g; r.parent && n < 8; n++) r = st.goals.get(r.parent) ?? r;
	return n;
};
export const subtree = (st: State, g: Goal): Goal[] => [g, ...parts(st, g).flatMap(c => subtree(st, c))];
/** Active goals the heartbeat audits: roots only; a part's progress counts for its root. */
export const roots = (st: State) => active(st).filter(g => !g.parent);
/** Knowledge visible from a goal: its ancestors' (shared context), its own and its parts'. */
export function knowledge(st: State, g: Goal): LearnE[] {
	const up: Goal[] = [];
	for (let r = g; r.parent && up.length < 8; ) {
		const p = st.goals.get(r.parent);
		if (!p) break;
		up.push(p);
		r = p;
	}
	return [...up, ...subtree(st, g)].flatMap(x => x.learned).sort((a, b) => epoch(a.ts) - epoch(b.ts));
}

/** Latest judge said "stuck" and nothing moved since: needs a human. */
export const stuck = (g: Goal) => g.judge?.verdict === "stuck" && g.progressSeq < g.judgeSeq;
/** A goal the worker can climb right now: open, present, measurable, not an umbrella, and not itself blocked by a stuck verdict. */
export const workable = (st: State, g: Goal) => !g.done && !g.moved && !g.gone?.length && !umbrella(st, g) && !stuck(g);
/** A stuck goal rests only itself: a tree the worker can still climb has at least one workable goal somewhere in it,
 *  so one part waiting on the human never idles its siblings. */
export const canClimb = (st: State, r: Goal) => subtree(st, r).some(x => workable(st, x));

/** Since the last heartbeat (or goal start): was anything kept, did a judge speak? */
export const keptSinceBeat = (g: Goal) => g.lastKeptSeq > (g.lastBeat?.seq ?? g.seq);
/** Research that ends in a goal's first scorecard counts, and so does that scorecard: landing it does not erase it. Re-baselines do not. */
const researched = (g: Goal, since: number) => (!g.card && g.lastProbeSeq > since) || g.firstCardSeq > since;
/** Progress for the heartbeat: kept results; before a scorecard exists, measured research items count. */
export const progressSinceBeat = (g: Goal) => keptSinceBeat(g) || researched(g, g.lastBeat?.seq ?? g.seq);
/** The same over a root and all its parts, measured from the root's last beat. */
export function treeProgressSinceBeat(st: State, root: Goal): boolean {
	// A STUCK verdict holds until something moves after it: research from before it released it at the next beat.
	const since = Math.max(root.lastBeat?.seq ?? root.seq, stuck(root) ? root.judgeSeq : -1);
	return subtree(st, root).some(g => g.lastKeptSeq > since || researched(g, since));
}
export const judgedSinceBeat = (g: Goal) => g.judgeSeq > (g.lastBeat?.seq ?? g.seq);

// ---------------------------------------------------------------------------
// Compaction: beats roll up hour -> day -> month as they age. Each goal keeps
// its newest KEEP_RAW beats raw. Converges in one call.

const KEEP_RAW = 20;
const LEVELS = [
	{ from: 0, to: 1, age: 86_400_000, key: (ts: string) => ts.slice(0, 13) },
	{ from: 1, to: 2, age: 7 * 86_400_000, key: (ts: string) => ts.slice(0, 10) },
	{ from: 2, to: 3, age: 30 * 86_400_000, key: (ts: string) => ts.slice(0, 7) },
];

export function compact(entries: Entry[], nowMs = clock.ms()): Entry[] {
	const rawBeats = new Map<string, number>();
	const keep = new Set<Entry>();
	for (let i = entries.length - 1; i >= 0; i--) {
		const e = entries[i];
		if (e.kind !== "beat") continue;
		const n = rawBeats.get(e.goal) ?? 0;
		if (n < KEEP_RAW) keep.add(e);
		rawBeats.set(e.goal, n + 1);
	}

	let cur = entries;
	for (const lvl of LEVELS) {
		const groups = new Map<string, (BeatE | RollupE)[]>();
		const out: Entry[] = [];
		for (const e of cur) {
			const depth = e.kind === "beat" ? 0 : e.kind === "rollup" ? e.cd : -1;
			if (depth !== lvl.from || keep.has(e) || nowMs - epoch(e.ts) <= lvl.age) {
				out.push(e);
				continue;
			}
			const k = `${e.goal}|${lvl.key(e.ts)}`;
			const grp = groups.get(k);
			if (grp) grp.push(e as BeatE | RollupE);
			else {
				groups.set(k, [e as BeatE | RollupE]);
				out.push(e); // placeholder keeps chronological slot
			}
		}
		cur = out.map(e => {
			const depth = e.kind === "beat" ? 0 : e.kind === "rollup" ? e.cd : -1;
			if (depth !== lvl.from || keep.has(e) || nowMs - epoch(e.ts) <= lvl.age) return e;
			const grp = groups.get(`${e.goal}|${lvl.key(e.ts)}`)!;
			let values: Values | undefined;
			for (const x of grp) if (x.values) values = x.values;
			const last = grp[grp.length - 1];
			return {
				ts: grp[0].ts,
				kind: "rollup",
				goal: e.goal,
				cd: lvl.to,
				n: grp.reduce((s, x) => s + (x.kind === "rollup" ? x.n : 1), 0),
				from: grp[0].kind === "rollup" ? grp[0].from : grp[0].ts,
				to: last.kind === "rollup" ? last.to : last.ts,
				progress: grp.reduce((s, x) => s + (x.kind === "rollup" ? x.progress : x.progress ? 1 : 0), 0),
				stale: last.stale,
				...(values ? { values } : {}),
			} satisfies RollupE;
		});
	}
	return cur;
}

export function rewrite(root: string, entries: Entry[]): void {
	const file = ledgerPath(root);
	const tmp = `${file}.${process.pid}.tmp`;
	fs.writeFileSync(tmp, entries.map(e => JSON.stringify(e)).join("\n") + "\n");
	fs.renameSync(tmp, file);
}
