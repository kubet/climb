// Traces: .climb/trace.jsonl. The ledger records decisions; this records the work
// behind them: every benchmark run, every climb tool call (refusals included), every
// judge call, with durations. Never folded into state, so it can grow and be capped.
import * as fs from "node:fs";
import * as path from "node:path";
import { DIR, type Entry, type ExpE, type ResultE, epoch } from "./ledger";

export const FILE = "trace.jsonl";
const CAP = 20_000;

/** What a run measured: a scorecard's smoke/A/A runs, an experiment's control, its result
 *  (plus a borderline re-check and the confirmation of "achieved"), the guard, a proof, a probe. */
export type Phase = "smoke" | "aa" | "control" | "result" | "recheck" | "paired" | "confirm" | "guard" | "proof" | "probe";

interface Base {
	ts: string;
	goal?: string;
}
export interface RunT extends Base {
	kind: "run";
	phase: Phase;
	metric?: string;
	/** Read from the output of a run made for another metric with the same command: it cost nothing. */
	shared?: true;
	/** Git tree measured: runs of one tree, at any time, are A/A data for its metric. */
	tree?: string;
	/** Fingerprint of the command: a metric re-registered with another command starts a new history. */
	cmd?: string;
	ms: number;
	code: number;
	value?: number;
	retry?: true;
	killed?: true;
	/** 1-minute load average and free memory when the run ended: contention is the first suspect for noise. */
	load?: number;
	free_mb?: number;
}
/** Runs not executed because the same tree and command were measured minutes ago, or a cut-off measurement had finished them. */
export interface ReuseT extends Base { kind: "reuse"; phase: Phase; metric: string; runs: number }
/** One finished pair of an interleaved measurement: base and candidate, back to back. */
export interface PairT extends Base { kind: "pair"; metric: string; cmd: string; base: string; cand: string; a: number; b: number }
export interface ToolT extends Base { kind: "tool"; tool: string; ms: number; ok: boolean; error?: string }
export interface JudgeT extends Base { kind: "judge"; ms: number; ok: boolean; error?: string; why: string }
export type Trace = RunT | ReuseT | PairT | ToolT | JudgeT;

const file = (root: string) => path.join(root, DIR, FILE);

export function append(root: string, t: Trace): void {
	try {
		fs.mkdirSync(path.join(root, DIR), { recursive: true });
		fs.appendFileSync(file(root), `${JSON.stringify(t)}\n`);
	} catch {} // tracing never breaks the climb
}

export function read(root: string): Trace[] {
	let text: string;
	try {
		text = fs.readFileSync(file(root), "utf8");
	} catch {
		return [];
	}
	const out: Trace[] = [];
	for (const line of text.split("\n")) {
		if (!line) continue;
		try {
			out.push(JSON.parse(line));
		} catch {}
	}
	return out;
}

/** Keeps the newest half once the file passes CAP lines (checked by size: cheap every tick). */
export function cap(root: string): void {
	try {
		if (fs.statSync(file(root)).size < CAP * 200) return;
	} catch {
		return;
	}
	const all = read(root);
	if (all.length <= CAP) return;
	const tmp = `${file(root)}.${process.pid}.tmp`;
	fs.writeFileSync(tmp, all.slice(-CAP / 2).map(t => JSON.stringify(t)).join("\n") + "\n");
	fs.renameSync(tmp, file(root));
}

/** Why a climb tool refused or failed, for the waste breakdown. */
export function refusal(error: string): string {
	const rules: [RegExp, string][] = [
		[/as large as the whole way|could be told apart from luck|No measurement can keep/, "too noisy for its target"],
		[/already meets its target/, "target already met"],
		[/Fix these metric commands|Control measurement failed|Measurement failed/, "a metric command crashed"],
		[/guard must pass|guard failed/, "guard failed"],
		[/since the last measured baseline/, "unmeasured commits refused"],
		[/dropped in a row/, "drop-streak gate"],
		[/judge is reviewing|STALLED/, "stall gate"],
		[/a probe, not a scorecard metric/, "prediction rests on a probe"],
		[/proof/i, "proof rejected"],
		[/dirty|uncommitted|Commit your change|still the base commit/, "tree not committed"],
		[/instrument changed|Commit the instrument/, "instrument changed or untracked"],
		[/Another omp\/pi session/, "lease held elsewhere"],
		[/interrupted/, "interrupted"],
		[/still open|is open/, "experiment already open"],
	];
	return rules.find(([re]) => re.test(error))?.[1] ?? "other";
}

export const dur = (ms: number) => {
	const m = Math.round(ms / 60_000);
	return ms < 1000 ? `${Math.round(ms)}ms` : ms < 60_000 ? `${Math.round(ms / 1000)}s` : m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
};
const sum = (xs: number[]) => xs.reduce((s, x) => s + x, 0);

const good = (traces: Trace[], goal: string, metric: string, sinceMs: number, cmd?: string) =>
	traces.filter(
		(x): x is RunT & { value: number } =>
			x.kind === "run" && x.goal === goal && x.metric === metric && x.code === 0 && typeof x.value === "number" && epoch(x.ts) >= sinceMs && (!cmd || x.cmd === cmd),
	);

/** Relative per-run spread pooled over every tree measured since `sinceMs`. Back-to-back A/A runs
 *  catch one calm moment; runs of the same code across hours also catch drift and load. */
export function pooledSd(traces: Trace[], goal: string, metric: string, sinceMs: number, cmd?: string): { sd: number; runs: number; trees: number } | undefined {
	const byTree = new Map<string, number[]>();
	for (const r of good(traces, goal, metric, sinceMs, cmd)) if (r.tree) byTree.set(r.tree, [...(byTree.get(r.tree) ?? []), r.value]);
	let ss = 0;
	let dof = 0;
	let runs = 0;
	let trees = 0;
	for (const xs of byTree.values()) {
		const mean = sum(xs) / xs.length;
		if (xs.length < 2 || !mean) continue;
		ss += xs.reduce((s, x) => s + ((x - mean) / mean) ** 2, 0);
		dof += xs.length - 1;
		runs += xs.length;
		trees++;
	}
	return dof >= 4 ? { sd: Math.sqrt(ss / dof), runs, trees } : undefined;
}

/** Good values of one tree in one phase since `sinceMs`, in order. */
export function runsOf(traces: Trace[], goal: string, metric: string, phase: Phase, tree: string, sinceMs: number, cmd: string): number[] {
	return good(traces, goal, metric, sinceMs, cmd).filter(r => r.phase === phase && r.tree === tree).map(r => r.value);
}

/** Pairs of these two trees and this command finished since `sinceMs`, in order. */
export function pairsOf(traces: Trace[], goal: string, metric: string, cmd: string, base: string, cand: string, sinceMs: number): [number, number][] {
	return traces
		.filter((x): x is PairT => x.kind === "pair" && x.goal === goal && x.metric === metric && x.cmd === cmd && x.base === base && x.cand === cand && epoch(x.ts) >= sinceMs)
		.map(x => [x.a, x.b]);
}

/** Median of every good run of one tree since `sinceMs`: a steadier reference than a single window. */
export function treeMedian(traces: Trace[], goal: string, metric: string, tree: string, sinceMs: number, cmd?: string): number | undefined {
	const xs = good(traces, goal, metric, sinceMs, cmd).filter(r => r.tree === tree).map(r => r.value);
	return xs.length ? medianOf(xs) : undefined;
}

/** Median load of a tree's good runs in some phases since `sinceMs`. */
export function loadOf(traces: Trace[], goal: string, tree: string, phases: Phase[], sinceMs: number): number | undefined {
	const xs = traces
		.filter((x): x is RunT => x.kind === "run" && x.goal === goal && x.tree === tree && phases.includes(x.phase) && typeof x.load === "number" && epoch(x.ts) >= sinceMs)
		.map(x => x.load!);
	return xs.length ? medianOf(xs) : undefined;
}

/** Typical duration of one good run of a metric, from recent traces. */
export function runMs(traces: Trace[], goal: string, metric: string): number | undefined {
	const ms = traces.filter((x): x is RunT => x.kind === "run" && x.goal === goal && x.metric === metric && x.code === 0 && !x.shared).slice(-20).map(x => x.ms);
	return ms.length ? medianOf(ms) : undefined;
}
const medianOf = (xs: number[]) => {
	const s = [...xs].sort((a, b) => a - b);
	return s.length ? (s.length % 2 ? s[s.length >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : 0;
};

/** Where the climb's time went over the last `windowMs`: tool time, waste, flaky
 *  instruments, cache savings, throughput. Short enough for a judge prompt. */
/** Where a climb's time went over the last `windowMs`, as numbers: the text summary and the panel both read it. */
export function summary(traces: Trace[], ledger: Entry[], nowMs: number, windowMs = 86_400_000) {
	const since = nowMs - windowMs;
	const t = traces.filter(x => epoch(x.ts) >= since);
	const tools = t.filter((x): x is ToolT => x.kind === "tool");
	const runs = t.filter((x): x is RunT => x.kind === "run");
	const reuse = t.filter((x): x is ReuseT => x.kind === "reuse");
	const judges = t.filter((x): x is JudgeT => x.kind === "judge");
	const byTool = new Map<string, number>();
	for (const x of tools) byTool.set(x.tool.replace("climb_", ""), (byTool.get(x.tool.replace("climb_", "")) ?? 0) + x.ms);
	const failed = tools.filter(x => !x.ok);
	const why = new Map<string, { n: number; ms: number }>();
	for (const x of failed) {
		const k = `${x.tool.replace("climb_", "")}: ${refusal(x.error ?? "")}`;
		const w = why.get(k) ?? { n: 0, ms: 0 };
		w.n++;
		w.ms += x.ms;
		why.set(k, w);
	}
	// A shared run is another metric's output read again: it took no time, and it is what one run of many numbers saves.
	const metered = runs.filter(x => x.metric && !x.shared);
	const shared = runs.filter(x => x.metric && x.shared);
	const cmdMs = (cmd?: string) => medianOf(metered.filter(x => x.cmd === cmd && x.code === 0).map(x => x.ms));
	const per = new Map<string, { n: number; bad: number; ms: number[] }>();
	for (const x of metered) {
		const p = per.get(x.metric!) ?? { n: 0, bad: 0, ms: [] };
		p.n++;
		if (x.code !== 0) p.bad++;
		else p.ms.push(x.ms);
		per.set(x.metric!, p);
	}
	const retried = metered.filter(x => x.retry);
	const guards = runs.filter(x => x.phase === "guard");
	const results = ledger.filter((e): e is ResultE => e.kind === "result" && epoch(e.ts) >= since);
	const exps = new Map(ledger.filter((e): e is ExpE => e.kind === "exp").map(e => [`${e.goal}|${e.id}`, e]));
	const cycles = results.map(r => exps.get(`${r.goal}|${r.exp}`)).map((e, i) => (e ? epoch(results[i].ts) - epoch(e.ts) : 0)).filter(Boolean);
	const firstResult = results.length ? Math.max(since, Math.min(...results.map(r => epoch(r.ts)))) : nowMs;
	const hours = Math.max(1 / 60, (nowMs - Math.max(since, Math.min(nowMs, ...t.map(x => epoch(x.ts)), firstResult))) / 3_600_000);
	return {
		traced: t.length > 0,
		tracedMs: t.length ? Math.min(windowMs, nowMs - Math.min(...t.map(x => epoch(x.ts)))) : 0,
		toolMs: sum(tools.map(x => x.ms)),
		byTool: [...byTool].filter(([, v]) => v >= 1000).sort((a, b) => b[1] - a[1]),
		wastedMs: sum(failed.map(x => x.ms)),
		wasted: [...why].map(([what, w]) => ({ what, ...w })).sort((a, b) => b.ms - a.ms),
		refused: failed.length,
		runs: metered.length,
		runMs: sum(metered.map(x => x.ms)),
		failedRuns: metered.filter(x => x.code !== 0).length,
		retries: retried.length,
		recovered: retried.filter(x => x.code === 0).length,
		flaky: [...per].filter(([, p]) => p.bad).map(([metric, p]) => ({ metric, bad: p.bad, n: p.n })).sort((a, b) => b.bad / b.n - a.bad / a.n),
		perRun: [...per].map(([metric, p]) => ({ metric, ms: medianOf(p.ms) })).sort((a, b) => b.ms - a.ms),
		reusedRuns: sum(reuse.map(r => r.runs)) + shared.length,
		savedMs: sum(reuse.map(r => r.runs * medianOf(per.get(r.metric)?.ms ?? [0]))) + sum(shared.map(x => cmdMs(x.cmd))),
		guard: { n: guards.length, failed: guards.filter(x => x.code !== 0).length, medianMs: medianOf(guards.map(x => x.ms)) },
		experiments: {
			n: results.length,
			kept: results.filter(r => r.verdict === "kept").length,
			byProof: results.filter(r => r.proof).length,
			abandoned: results.filter(r => r.reason.startsWith("abandoned:")).length,
			perHour: results.length / hours,
			medianCycleMs: medianOf(cycles),
			windowMs: nowMs - firstResult,
		},
		judge: { n: judges.length, failed: judges.filter(j => !j.ok).length, medianMs: medianOf(judges.map(j => j.ms)) },
	};
}

/** The same, as a few lines of text: for /climb, climb_status and the judge's prompt. */
export function stats(traces: Trace[], ledger: Entry[], nowMs: number, windowMs = 86_400_000): string {
	const s = summary(traces, ledger, nowMs, windowMs);
	if (!s.traced) return "";
	const out = [`efficiency, traced over the last ${dur(s.tracedMs)}:`];
	out.push(`- climb tools ${dur(s.toolMs)}: ${s.byTool.map(([k, v]) => `${k} ${dur(v)}`).join(", ")}`);
	if (s.refused) out.push(`- wasted ${dur(s.wastedMs)} in ${s.refused} refused/failed calls: ${s.wasted.slice(0, 5).map(w => `${w.what} ×${w.n} (${dur(w.ms)})`).join("; ")}`);
	if (s.runs)
		out.push(
			`- runs ${s.runs} (${dur(s.runMs)}): ${s.failedRuns} failed${s.retries ? `, ${s.recovered}/${s.retries} retries recovered` : ""}${s.flaky.length ? ` · flaky: ${s.flaky.slice(0, 3).map(f => `${f.metric} ${f.bad}/${f.n}`).join(", ")}` : ""} · per run: ${s.perRun.slice(0, 3).map(p => `${p.metric} ${dur(p.ms)}`).join(", ")}${s.reusedRuns ? ` · reuse saved ~${dur(s.savedMs)} (${s.reusedRuns} runs)` : ""}`,
		);
	if (s.guard.n) out.push(`- guard ${s.guard.n}× (median ${dur(s.guard.medianMs)}, ${s.guard.failed} failed); guard passes on a tree are reused for 30 minutes`);
	const e = s.experiments;
	if (e.n)
		out.push(
			`- experiments decided in the last ${dur(e.windowMs)}: ${e.n} (${e.perHour.toFixed(1)}/h, median ${dur(e.medianCycleMs)} from registration to verdict): ${e.kept} kept${e.byProof ? ` (${e.byProof} by proof)` : ""}, ${e.n - e.kept} dropped${e.abandoned ? ` (${e.abandoned} abandoned unmeasured)` : ""}`,
		);
	if (s.judge.n) out.push(`- judge ${s.judge.n}× (median ${dur(s.judge.medianMs)})${s.judge.failed ? `, ${s.judge.failed} failed` : ""}`);
	return out.join("\n");
}
