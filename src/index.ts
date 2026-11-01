// climb — autonomous hill-climbing for pi / omp.
//
// The LLM is a stateless worker. This extension is the enforcer:
//   - owns the ledger (.climb/oracle.jsonl); the worker cannot edit it
//   - measures every metric itself, on commits only, against a control
//     measured at pre-registration; decides kept/dropped; reverts drops
//   - blocks the worker from stopping while a goal is open (session_stop)
//   - heartbeat: every beat_s it audits progress; skipped while the worker is
//     busy, forced at 2x as a watchdog; poke_max stale beats -> a separate
//     judge model call diagnoses the stall and redirects the worker
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as L from "./ledger";
import * as X from "./logic";
import * as E from "./export";
import * as P from "./panel";
import * as T from "./trace";

const TICK_MS = 15_000;
const JUDGE_MS = 5 * 60_000;
const LEDGER_GUARD = "The climb ledger (.climb/) is append-only and owned by the climb extension. Read it with climb_status.";
// Measuring runs every sample of every metric: it can outlast a script's or eval cell's timeout (omp's eval stops at one hour).
const DIRECT = " Call it directly, not from eval or a script: measuring can outlast their timeouts.";
const RESUMES = " The runs it finished count: climb_measure resumes from them.";
// An instrument that keeps outputs per run (voice's call recordings: 9 GB a day) fills a disk over nights of measuring.
const DISK_MIN = 2 * 2 ** 30;
/** The most pairs a streak check takes to see a slide, and the time they may take (fewer pairs for a slow metric). */
const SLIDE_PAIRS = 20;
const SLIDE_BUDGET_MS = 40 * 60_000;
/** Free bytes on a directory's disk (replaceable, like L.clock, for tests). */
/** A failed run (a crash, or no number: an API that rate-limited or blipped) is retried once, after a pause: an instant
 *  retry hits the same outage (voice's control failed when its router bench printed NaN three times in a row). */
export const retry = { ms: Number(process.env.CLIMB_RETRY_MS ?? 20_000) };
const pause = (signal?: AbortSignal) =>
	new Promise<void>(resolve => {
		const t = setTimeout(resolve, retry.ms);
		signal?.addEventListener("abort", () => (clearTimeout(t), resolve()), { once: true });
	});
const numberIn = (r: { code: number; stdout: string }, name: string) => {
	const n = r.code === 0 ? X.valueOf(r.stdout, name) : undefined;
	return n !== undefined && Number.isFinite(n) ? n : undefined;
};

export const disk = {
	free(dir: string): number {
		try {
			const s = fs.statfsSync(dir);
			return s.bavail * s.bsize;
		} catch {
			return Number.POSITIVE_INFINITY;
		}
	},
};
const gib = (b: number) => `${(b / 2 ** 30).toFixed(1)} GiB`;

type Ctx = ExtensionContext;
type Progress = (text: string) => void;
type Tag = { phase: T.Phase; goal?: string; metric?: string; tree?: string; cmd?: string };
type Update = (partial: { content: { type: "text"; text: string }[] }) => void;
// Instruments outside the repo worth warning about; system tools are not instruments.
/** A positive number, or the default: strict-schema providers send 0 or null for "not given". */
const pos = (v: number | null | undefined, d: number) => (typeof v === "number" && v > 0 ? v : d);
const SYSTEM = /^\/(dev|usr|bin|sbin|etc|opt|nix|proc|System|Library|Applications)(\/|$)/;
const sha = (text: string) => createHash("sha1").update(text).digest("hex");
/** A path with its directory's symlinks resolved (/tmp is /private/tmp); the file need not exist. */
function realish(p: string): string {
	try {
		return path.join(fs.realpathSync(path.dirname(p)), path.basename(p));
	} catch {
		return p;
	}
}
const cmdId = (cmd: string) => sha(cmd).slice(0, 8);
// What a base worktree never borrows from the repo. Build outputs and caches are derived from the code
// (only untracked or ignored paths are linked at all, so an ignored lib/ or bin/ is a build output):
// the candidate's would be measured on the base side.
export const DERIVED =
	/(^|\/)(dist|build|out|lib|bin|obj|target|\.next|\.nuxt|\.svelte-kit|\.output|\.vercel|\.expo|\.angular|\.docusaurus|\.turbo|\.cache|\.parcel-cache|\.gradle|coverage|__pycache__|\.pytest_cache|\.mypy_cache|\.ruff_cache)(\/|$)|\.(pyc|o|class|tsbuildinfo)$/;
// Mutable environments: tools rewrite them in place (uv run re-points an editable install at whatever
// tree runs it) and editable installs point back at the repo's code. The base builds its own, or falls back.
export const ENVS = /(^|\/)(\.venv|venv|\.tox|\.nox|\.direnv)(\/|$)/;

/** A linked folder (or its first level, scoped packages included) holding a symlink into the repo's own
 *  tracked code, like a workspace package in node_modules, would run the candidate's code on the base side. */
// The links' real paths, resolved once per list: checking each of n links against all n is otherwise n² realpaths.
const sharedOf = new WeakMap<string[], string[]>();
export function leaksIntoRepo(root: string, rel: string, linked: string[]): boolean {
	const real = (p: string) => {
		try {
			return fs.realpathSync(p);
		} catch {
			return p;
		}
	};
	const top = real(root);
	let shared = sharedOf.get(linked);
	if (!shared) sharedOf.set(linked, (shared = linked.map(l => real(path.join(root, l)))));
	const leaks = (p: string) => {
		const r = real(p);
		return r.startsWith(top + path.sep) && !shared!.some(x => r === x || r.startsWith(x + path.sep));
	};
	const src = path.join(root, rel);
	const isLink = (p: string) => {
		try {
			return fs.lstatSync(p).isSymbolicLink();
		} catch {
			return false;
		}
	};
	if (isLink(src)) return leaks(src);
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(src, { withFileTypes: true });
	} catch {
		return false;
	}
	let seen = 0;
	for (const e of entries) {
		if (++seen > 5000) return true; // too large to vet: do not risk it
		const p = path.join(src, e.name);
		if (e.isSymbolicLink() && leaks(p)) return true;
		if (e.isDirectory() && e.name.startsWith("@")) {
			for (const s of fs.readdirSync(p, { withFileTypes: true })) if (s.isSymbolicLink() && leaks(path.join(p, s.name))) return true;
		}
	}
	return false;
}
/** The machine measurements run on: a result is "metric M on commit C, instrument I, environment E".
 *  The harness driving the climb is recorded beside it; the hash stays the machine's. */
const envOf = (harness: string): L.Env => {
	const cpus = os.cpus();
	const facts = {
		host: os.hostname(),
		os: `${os.platform()} ${os.release()}`,
		arch: os.arch(),
		cpus: cpus.length,
		cpu: cpus[0]?.model?.trim() ?? "?",
		mem_gb: Math.round(os.totalmem() / 2 ** 30),
		runtime: process.versions.bun ? `bun ${process.versions.bun}` : `node ${process.versions.node}`,
	};
	return { ...facts, harness, hash: sha(JSON.stringify(facts)).slice(0, 12) };
};

/** Newest modification time of this extension's sources: a running session compares it with what it loaded. */
function sourceStamp(): number {
	try {
		const dir = path.dirname(fileURLToPath(import.meta.url));
		return Math.max(...fs.readdirSync(dir).filter(f => f.endsWith(".ts")).map(f => fs.statSync(path.join(dir, f)).mtimeMs));
	} catch {
		return 0;
	}
}

export default async function climb(pi: ExtensionAPI) {
	const S = await schemas(pi);
	// A session keeps the code it started with; say so when a newer climb is installed.
	const loadedStamp = sourceStamp();
	let staleCode = false;
	const omp = "zod" in pi && !!(pi as { zod?: unknown }).zod;
	// omp, pi, or a host shim that names itself (Claude Code's): one scorecard climbed by two harnesses compares from the exports.
	const harness = (pi as { harness?: string }).harness ?? (omp ? "omp" : "pi");
	const ENV = envOf(harness);
	// What the session learned in memory survives a hot update (Claude Code swaps in a newer climb between tool
	// calls): a host that keeps the session hands the same object to the next version.
	const keep = ((pi as { keep?: Record<string, unknown> }).keep ?? {}) as Record<string, unknown>;
	const kept = <T>(name: string, make: () => T): T => (keep[name] ??= make()) as T;
	const roots = new Map<string, string>();
	/** Root goals this session started or named. */
	const mine = kept("mine", () => new Set<string>());
	const judging = kept("judging", () => new Set<string>());
	let ctxRef: Ctx | undefined;
	let timer: unknown;
	let beating = false;
	let stopIdle = 0;
	let stopLines = -1;
	let rests = 0;
	let judgeBroken = false;
	const hasJudge = (ctx: Ctx) => typeof ctx.runEphemeralTurn === "function" && !judgeBroken;
	let restProgress = -2;

	// --- shell -----------------------------------------------------------------

	const sh = (root: string, cmd: string, timeoutMs: number, signal?: AbortSignal) =>
		pi.exec("bash", ["-c", cmd], { cwd: root, timeout: timeoutMs, signal });
	const git = (root: string, ...args: string[]) => pi.exec("git", args, { cwd: root, timeout: 60_000 });
	/** sh, traced: every benchmark, guard, proof and probe run lands in .climb/trace.jsonl with its duration. */
	/** `ledger`: the repo whose trace records the run (a base worktree's runs belong to the repo). */
	async function run(root: string, cmd: string, timeoutMs: number, tag: Tag, signal?: AbortSignal, retry = false, ledger = root) {
		// A full disk breaks the instrument, git and the ledger at once: measuring stops first, deciding nothing.
		if (tag.metric && disk.free(root) < DISK_MIN)
			throw new Error(
				`The disk is nearly full (${gib(disk.free(root))} free): measuring stopped before it fills it, and nothing was decided. Free space, often an instrument's per-run outputs (recordings, logs) among the repo's git-ignored files, then call again.`,
			);
		const t0 = performance.now();
		const r = await sh(root, cmd, timeoutMs, signal);
		const value = r.code === 0 && tag.metric ? X.valueOf(r.stdout, tag.metric) : undefined;
		const load = Math.round(os.loadavg()[0] * 100) / 100; // contention is the first suspect for a noisy run
		const free_mb = Math.round(os.freemem() / 2 ** 20);
		T.append(ledger, { ts: L.now(), kind: "run", ...tag, ms: Math.round(performance.now() - t0), code: r.code, value, retry: retry || undefined, killed: r.killed || undefined, load, free_mb });
		return r;
	}
	const tail = (s: string) => s.replace(/[ \t]{2,}/g, " ").replace(/\n\s*\n/g, "\n").trim().slice(-400);
	// Both streams: `bun run x` echoes the script on stderr while tsc prints its errors on stdout.
	const said = (r: { stdout: string; stderr: string }) => tail(`${r.stdout}\n${r.stderr}`);

	/** The checkout a session climbs: its own, or the one its climb moved to (followed at once, no restart). */
	async function repoRoot(cwd: string): Promise<string | undefined> {
		let top = roots.get(cwd);
		if (!top) {
			const r = await pi.exec("git", ["rev-parse", "--show-toplevel"], { cwd, timeout: 10_000 });
			if (r.code !== 0) return undefined;
			top = r.stdout.trim();
			roots.set(cwd, top);
		}
		return awayOf(top) ?? top;
	}

	// A climb that moved out of a checkout (its instrument lives elsewhere, or other work dirtied it) leaves
	// .climb/away.json behind: sessions there follow it while it climbs on, unless another live session climbs here.
	const away = kept("away", () => new Map<string, string>());
	const AWAY = "away.json";
	function awayOf(top: string): string | undefined {
		const mem = away.get(top);
		if (mem) return mem;
		const file = path.join(top, L.DIR, AWAY);
		if (!fs.existsSync(file)) return undefined;
		try {
			const { to, goal } = JSON.parse(fs.readFileSync(file, "utf8")) as { to?: unknown; goal?: unknown };
			if (typeof to !== "string" || !L.active(load(to)).some(g => goal === "*" || g.id === goal) || leasedElse(top)) return undefined;
			away.set(top, to);
			return to;
		} catch {
			return undefined;
		}
	}
	function leasedElse(root: string): boolean {
		try {
			const cur = JSON.parse(fs.readFileSync(path.join(root, L.DIR, "lease.json"), "utf8")) as { who: string; ts: number };
			return cur.who !== me(ctxRef as Ctx) && L.clock.ms() - cur.ts < LEASE_STALE_MS && !gone(cur.who);
		} catch {
			return false;
		}
	}

	/** Carries a goal, with its parts, to the checkout it climbs in; this session follows it there at once.
	 *  `keep`: sessions in `from` follow it after a restart too (not when another live session climbs `from`). */
	async function relocate(ctx: Ctx, from: string, g: L.Goal, to: string, why: string, keep: boolean): Promise<void> {
		const st = load(from);
		const top = L.rootOf(st, g);
		const ids = new Set(L.subtree(st, top).map(x => x.id));
		const there = load(to);
		const clash = [...ids].find(id => there.goals.has(id));
		if (clash) throw new Error(`${to} already has a climb goal ${clash}; finish it there (/climb done ${clash}) or pass another goal.`);
		// Notes about the old checkout (its dirty tree, a binding, a move only the user could make) are not carried: once the
		// goal had moved, platinum's judge still read "bound to platinum-dev" and asked the user to re-bind it.
		const stale = (e: L.Entry) => e.kind === "learn" && e.text.includes(from);
		L.append(to, ...L.read(from).filter(e => ids.has(e.goal) && !stale(e)), {
			ts: L.now(),
			kind: "learn",
			goal: top.id,
			type: "fact",
			text: `This goal climbs in ${to} since ${L.now().slice(0, 16).replace("T", " ")} (moved from ${from}: ${why.split(";")[0]}); the climb moved it itself, and nothing about ${path.basename(from)} binds it now.`.slice(0, 600),
		});
		for (const t of T.read(from)) if (t.goal && ids.has(t.goal)) T.append(to, t);
		await ensureExcluded(to);
		append(from, ...[...ids].map(id => ({ ts: L.now(), kind: "moved" as const, goal: id, to })));
		if (keep) fs.writeFileSync(path.join(from, L.DIR, AWAY), JSON.stringify({ to, goal: top.id }));
		away.set(from, to);
		release(from, ctx);
		lease(to, ctx, true);
		notices.push(`${top.id} now climbs in ${to} (${why}). Work there: edit, commit and run everything under ${to}. This session follows it with no restart; ${from} is left as it is.`);
		refresh(ctx, to);
	}

	/** The climb's own checkout beside a shared one (<repo>-climb, branch climb/<goal>), with the repo's
	 *  ignored dependencies and env files (node_modules, .env) linked in. */
	async function ownCheckout(root: string, id: string): Promise<string> {
		let dir = `${root}-climb`;
		for (let i = 2; fs.existsSync(dir); i++) dir = `${root}-climb-${i}`;
		let r = await git(root, "worktree", "add", "-b", `climb/${id}`, dir, "HEAD");
		if (r.code !== 0) r = await git(root, "worktree", "add", "--detach", dir, "HEAD");
		if (r.code !== 0) throw new Error(`climb could not make its own checkout (git worktree add ${dir} HEAD): ${said(r)}`);
		const ignored = (await git(root, "ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--directory")).stdout
			.split("\0")
			.map(l => l.replace(/\/+$/, ""))
			.filter(l => l && l !== L.DIR && !l.startsWith(`${L.DIR}/`) && !DERIVED.test(l) && !ENVS.test(l));
		for (const rel of ignored.filter(rel => !leaksIntoRepo(root, rel, ignored))) {
			const target = path.join(dir, rel);
			if (fs.existsSync(target)) continue;
			fs.mkdirSync(path.dirname(target), { recursive: true });
			fs.symlinkSync(path.join(root, rel), target);
		}
		return dir;
	}

	async function needRoot(ctx: Ctx): Promise<string> {
		const root = await repoRoot(ctx.cwd);
		if (!root) throw new Error("climb needs a git repository: git is the source of truth.");
		return root;
	}

	async function head(root: string): Promise<string | undefined> {
		const r = await git(root, "rev-parse", "HEAD");
		return r.code === 0 ? r.stdout.trim() : undefined;
	}

	async function tree(root: string, rev = "HEAD"): Promise<string | undefined> {
		const r = await git(root, "rev-parse", `${rev}^{tree}`);
		return r.code === 0 ? r.stdout.trim() : undefined;
	}

	/** Tracked changes only: untracked build junk (caches, logs) does not change what a commit measures. */
	async function dirty(root: string): Promise<string> {
		const r = await git(root, "status", "--porcelain", "--untracked-files=no");
		return r.stdout
			.split("\n")
			.filter(l => l.trim() && !l.slice(3).startsWith(`${L.DIR}/`))
			.join("\n");
	}

	/** Measuring must not change the tree: restore tracked files a metric/guard run rewrote
	 *  (only ever called on a tree that was clean before the run). */
	async function restore(root: string): Promise<string[]> {
		const d = await dirty(root);
		if (!d) return [];
		const paths = d.split("\n").map(l => l.slice(3));
		await git(root, "checkout", "--", ...paths);
		touched.push(...paths);
		return paths;
	}
	const touched: string[] = [];
	const notices: string[] = []; // said once, with the next tool result
	const artifactNote = () => {
		const t = [...new Set(touched.splice(0))];
		const said = [...new Set(notices.splice(0))].map(n => `\nNote: ${n}`).join("");
		return (t.length ? `\nNote: measuring rewrote tracked files (${t.join(", ")}); restored. Untrack generated artifacts (git rm --cached) so they stop churning.` : "") + said;
	};

	async function ensureExcluded(root: string): Promise<void> {
		const r = await git(root, "rev-parse", "--git-path", "info/exclude");
		if (r.code !== 0) return;
		const file = path.resolve(root, r.stdout.trim());
		let text = "";
		try {
			text = fs.readFileSync(file, "utf8");
		} catch {}
		if (/^\/?\.climb\/?$/m.test(text)) return;
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.appendFileSync(file, `${text && !text.endsWith("\n") ? "\n" : ""}${L.DIR}/\n`);
	}

	/** Runs every metric `samples` times (plus any prior samples, merged) and takes medians.
	 *  A failed run is retried once: one flaky run must not void a long measurement. */
	async function measure(
		root: string,
		metrics: L.Metric[],
		tag: Tag,
		signal?: AbortSignal,
		prior: Record<string, number[]> = {},
		progress?: Progress,
		stop?: (m: L.Metric, xs: number[]) => string | undefined,
	) {
		const values: L.Values = {};
		const samples: Record<string, number[]> = {};
		const got: Record<string, number[]> = {}; // every good run, including those of a metric that failed later
		const ms: Record<string, number[]> = {}; // durations of the good runs, for cost-aware advice
		const errors: string[] = [];
		let stopped: string | undefined; // a finished metric that already decides the call: skip the rest
		// Metrics with one command share its runs: the i-th run of a command feeds the i-th sample of each
		// (voice ran one 5-minute call bench twice per sample, once per number it prints).
		const outs = new Map<string, { stdout: string; stderr: string; code: number; killed?: boolean }[]>();
		try {
		for (const m of metrics) {
			const xs: number[] = [];
			const made = outs.get(m.cmd) ?? [];
			outs.set(m.cmd, made);
			// A parallel metric runs `slots` samples at once, each told its slot ($CLIMB_SLOT) for its port.
			const k = X.slots(m);
			/** One sample: its value, or why there is none. */
			const sample = async (i: number, slot: number): Promise<{ n?: number; err?: string }> => {
				const t0 = performance.now();
				if (made[i]) {
					const n = X.valueOf(made[i].stdout, m.name);
					if (n === undefined || !Number.isFinite(n)) return { err: `${m.name}: no number in output: ${tail(made[i].stdout) || "(empty)"}` };
					T.append(root, { ts: L.now(), kind: "run", ...tag, metric: m.name, cmd: cmdId(m.cmd), ms: 0, code: 0, value: n, shared: true });
					(ms[m.name] ??= []).push(ms[metrics.find(o => o.cmd === m.cmd)!.name]?.[i] ?? 0);
					return { n };
				}
				progress?.(`${m.name} run ${i + 1}/${m.samples}${k > 1 ? ` (${k} at once)` : ""}`);
				const cmd = k > 1 ? `export CLIMB_SLOT=${slot}; ${m.cmd}` : m.cmd;
				let r = await run(root, cmd, m.timeout_s * 1000, { ...tag, metric: m.name, cmd: cmdId(m.cmd) }, signal);
				if (numberIn(r, m.name) === undefined && !r.killed && !signal?.aborted) {
					if (k === 1) await restore(root); // never under a run still going beside it
					progress?.(`${m.name} run ${i + 1}/${m.samples}: ${r.code === 0 ? "no number" : `exit ${r.code}`}, retrying in ${Math.round(retry.ms / 1000)}s`);
					await pause(signal);
					if (!signal?.aborted) r = await run(root, cmd, m.timeout_s * 1000, { ...tag, metric: m.name, cmd: cmdId(m.cmd) }, signal, true);
				}
				// An operator interrupt is not a verdict: nothing is decided or reverted.
				if (signal?.aborted)
					throw new Error(
						["control", "aa", "smoke"].includes(tag.phase)
							? "Measurement interrupted; nothing was registered."
							: `Measurement interrupted; nothing was decided and the experiment stays open.${["result", "recheck"].includes(tag.phase) ? RESUMES : ""}`,
					);
				if (r.code !== 0) return { err: `${m.name}: exit ${r.code}${r.killed ? " (killed/timeout)" : ""}: ${said(r)}` };
				made[i] = r;
				const n = X.valueOf(r.stdout, m.name);
				if (n === undefined || !Number.isFinite(n)) return { err: `${m.name}: no number in output: ${tail(r.stdout) || "(empty)"}` };
				(ms[m.name] ??= []).push(performance.now() - t0);
				return { n };
			};
			for (let i = 0; i < m.samples; i += k) {
				const batch = Array.from({ length: Math.min(k, m.samples - i) }, (_, j) => sample(i + j, j));
				const done = await Promise.all(batch);
				if (k > 1) await restore(root);
				for (const x of done) if (x.n !== undefined) xs.push(x.n);
				const bad = done.find(x => x.err);
				if (bad) {
					errors.push(bad.err!);
					break;
				}
			}
			got[m.name] = [...(prior[m.name] ?? []), ...xs];
			if (xs.length < m.samples) continue;
			samples[m.name] = got[m.name];
			values[m.name] = X.median(samples[m.name]);
			stopped = stop?.(m, samples[m.name]);
			if (stopped) break;
		}
		} finally {
			await restore(root);
			progress?.("");
		}
		return { values, samples, errors, got, ms, stopped };
	}

	// Unbiased runs (A/A, controls) by tree and command. A tree measured minutes ago is
	// not measured again: a rejected scorecard retries for free, and the control after a
	// revert reuses the runs of the tree it restored. Results kept on a measured gain never
	// enter the cache: they were selected for measuring well. Those kept on a proof were not.
	const FRESH_MS = 30 * 60_000;
	const runs = kept("runs", () => new Map<string, { ts: number; xs: number[] }>());
	async function measureTree(
		root: string,
		metrics: L.Metric[],
		need: (m: L.Metric) => number,
		tag: Tag,
		signal?: AbortSignal,
		progress?: Progress,
		stop?: (m: L.Metric, xs: number[]) => string | undefined,
	) {
		const t = await tree(root);
		const prior: Record<string, number[]> = {};
		const plan = metrics.map(m => {
			const hit = t ? runs.get(`${t}\0${m.name}\0${m.cmd}`) : undefined;
			prior[m.name] = hit && L.clock.ms() - hit.ts < FRESH_MS ? hit.xs : [];
			return { ...m, samples: Math.max(0, need(m) - prior[m.name].length) };
		});
		for (const m of metrics) {
			const runs = Math.min(prior[m.name].length, need(m));
			if (runs) T.append(root, { ts: L.now(), kind: "reuse", ...tag, metric: m.name, runs });
		}
		// The plan's metrics count only the runs still needed: `stop` judges the real metric.
		const byName = new Map(metrics.map(m => [m.name, m]));
		const r = await measure(root, plan, { ...tag, tree: t }, signal, prior, progress, stop && ((m, xs) => stop(byName.get(m.name)!, xs)));
		// Good runs are kept even when a later run of the same metric crashed: a retry only tops up.
		for (const m of plan) {
			const key = `${t}\0${m.name}\0${m.cmd}`;
			const xs = r.got[m.name] ?? [];
			if (t && xs.length > prior[m.name].length) runs.set(key, { ts: prior[m.name].length ? runs.get(key)!.ts : L.clock.ms(), xs });
		}
		return { ...r, reused: plan.filter(m => !m.samples).map(m => m.name) };
	}

	/** Live progress of a long measurement: the tool's partial output and the status line. */
	const progressTo =
		(ctx: Ctx, root: string, onUpdate: Update | undefined, what: string): Progress =>
		text => {
			if (!text) return void refresh(ctx, root);
			onUpdate?.({ content: [{ type: "text", text: `${what}: ${text}` }] });
			ctx.ui?.setStatus?.("climb", `⛰ ${what}: ${text}`);
		};

	/** Runs fn in a throwaway worktree of `sha`, outside the repo (benchmarks that scan the repo must not
	 *  find it), with every untracked and ignored path of the repo linked in: dependencies, env files and
	 *  data are not in the commit. Undefined when the worktree cannot be made. */
	async function withBase<R>(root: string, sha: string, fn: (dir: string) => Promise<R>): Promise<R | undefined> {
		const holder = fs.mkdtempSync(path.join(os.tmpdir(), "climb-base-"));
		const dir = path.join(holder, "tree");
		const links: string[] = [];
		try {
			// Setup problems mean "cannot pair", never a failed measurement: the caller falls back.
			try {
				const add = await git(root, "worktree", "add", "--detach", "--force", dir, sha);
				if (add.code !== 0) return undefined;
				const listed = await Promise.all([
					git(root, "ls-files", "-z", "--others", "--exclude-standard", "--directory"),
					git(root, "ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--directory"),
				]);
				const extra = [
					...new Set(
						listed
							.flatMap(r => r.stdout.split("\0"))
							.map(l => l.replace(/\/+$/, ""))
							.filter(l => l && l !== L.DIR && !l.startsWith(`${L.DIR}/`) && !DERIVED.test(l) && !ENVS.test(l)),
					),
				];
				if (extra.some(rel => leaksIntoRepo(root, rel, extra))) return undefined;
				for (const rel of extra) {
					const target = path.join(dir, rel);
					if (fs.existsSync(target)) continue;
					fs.mkdirSync(path.dirname(target), { recursive: true });
					fs.symlinkSync(path.join(root, rel), target);
					links.push(target);
				}
			} catch {
				return undefined;
			}
			return await fn(dir);
		} finally {
			for (const l of links) fs.rmSync(l, { force: true }); // unlink first: removal must never reach into the repo
			await git(root, "worktree", "remove", "--force", dir);
			await git(root, "worktree", "prune");
			fs.rmSync(holder, { recursive: true, force: true });
		}
	}

	/** Base and candidate measured interleaved (A B, B A, ...): drift between the two sides cancels.
	 *  Undefined if the base cannot be checked out or a run fails (the caller falls back). */
	/** Pairs per metric; undefined when the base cannot be checked out or cannot run the command at all (its
	 *  first run fails); a string when a later run failed even on a retry: one bad run must not throw the
	 *  pairs away and leave the decision to a single draw. With `since` (an open experiment's start), pairs
	 *  finished since then count: a measurement that was cut off resumes, and a retry cannot re-roll them. */
	/** `cap`: the most pairs a metric gets (a streak check pairs until it can see a slide). */
	async function paired(root: string, base: string, metrics: L.Metric[], goal: string, signal?: AbortSignal, progress?: Progress, since?: number, cap: number = X.PAIRS): Promise<Record<string, [number, number][]> | string | undefined> {
		const [baseTree, candTree] = await Promise.all([tree(root, base), tree(root)]);
		const traces = since === undefined ? [] : T.read(root);
		try {
			return await withBase(root, base, async dir => {
				const out: Record<string, [number, number][]> = {};
				// One command's run feeds every metric it prints, pair by pair and side by side.
				const made = new Map<string, string>();
				for (const m of metrics) {
					// A close call gets every pair it may; a clear one stops at 3 (settled). Pairing only samples+2 times left a
					// noisy jury 3 pairs: platinum's x2 read +28%, +25%, -12% and was dropped at ±69%, where 6 would read ±29%.
					const n = cap;
					const ps = since !== undefined && baseTree && candTree ? T.pairsOf(traces, goal, m.name, cmdId(m.cmd), baseTree, candTree, since).slice(0, n) : [];
					if (ps.length) T.append(root, { ts: L.now(), kind: "reuse", phase: "paired", goal, metric: m.name, runs: 2 * ps.length });
					// Three pairs that already decide with room to spare end it: the rest could not change the call.
					// A parallel metric runs both sides of a pair at once; with more slots, several pairs at once (two slots each).
					const both = X.slots(m) >= 2;
					const P = Math.max(1, Math.floor(X.slots(m) / 2));
					/** Pair i, in its batch's j-th place: its two values, or why it could not run. */
					const pair = async (i: number, j: number): Promise<[number, number] | string> => {
						const v: { a?: number; b?: number } = {};
						/** One side's run: undefined when it ran, else why it could not. */
						const one = async (side: "a" | "b"): Promise<string | undefined> => {
							const who = side === "a" ? "base" : "candidate";
							const memo = `${side}\0${m.cmd}\0${i}`;
							const prior = made.get(memo);
							const tag = { phase: "paired" as const, goal, metric: m.name, tree: side === "a" ? baseTree : candTree, cmd: cmdId(m.cmd) };
							if (prior !== undefined) {
								const y = X.valueOf(prior, m.name);
								if (y === undefined || !Number.isFinite(y)) return `${m.name}, ${who} run of pair ${i + 1}: no number in its output`;
								T.append(root, { ts: L.now(), kind: "run", ...tag, ms: 0, code: 0, value: y, shared: true });
								v[side] = y;
								return undefined;
							}
							progress?.(`${m.name} pair ${i + 1}/${n}, ${both ? `base and candidate at once${P > 1 ? `, ${P} pairs at a time` : ""}` : who}`);
							let r: Awaited<ReturnType<typeof run>> | undefined;
							for (let attempt = 0; attempt < 2 && v[side] === undefined; attempt++) {
								if (attempt > 0) await pause(signal);
								// $CLIMB_SLOT tells runs at once apart (their ports): the candidate takes 2j, the base 2j + 1.
								r = await run(side === "a" ? dir : root, `export CLIMB_SLOT=${2 * j + (side === "a" ? 1 : 0)}; ${m.cmd}`, m.timeout_s * 1000, tag, signal, attempt > 0, root);
								if (signal?.aborted) throw new Error(`Measurement interrupted; nothing was decided and the experiment stays open.${since === undefined ? "" : RESUMES}`);
								const y = r.code === 0 ? X.valueOf(r.stdout, m.name) : undefined;
								if (y !== undefined && Number.isFinite(y)) {
									v[side] = y;
									made.set(memo, r.stdout);
								}
							}
							if (v[side] !== undefined) return undefined;
							return `${m.name}, ${who} run of pair ${i + 1}: ${r!.code === 0 ? "no number in its output" : `exit ${r!.code}${r!.killed ? " (killed/timeout)" : ""}: ${said(r!)}`}`;
						};
						// Side by side, both runs see the same network and load: drift cancels exactly, in half the time.
						// Which side starts first alternates too, so a head start (a warm cache, the first port) cancels.
						const failed = both
							? (await Promise.all(i % 2 ? [one("b"), one("a")] : [one("a"), one("b")])).find(Boolean)
							: ((await one(i % 2 ? "b" : "a")) ?? (await one(i % 2 ? "a" : "b")));
						return failed ?? [v.a!, v.b!];
					};
					for (let i = ps.length; i < n && !X.settled(m, ps); i += P) {
						const batch = Array.from({ length: Math.min(P, n - i) }, (_, j) => pair(i + j, j));
						for (const [q, r] of (await Promise.all(batch)).entries()) {
							if (typeof r === "string") {
								if (i + q === 0 && !Object.keys(out).length && !r.includes("candidate")) return undefined; // the base cannot run it here
								return r;
							}
							ps.push(r);
							if (baseTree && candTree) T.append(root, { ts: L.now(), kind: "pair", goal, metric: m.name, cmd: cmdId(m.cmd), base: baseTree, cand: candTree, a: r[0], b: r[1] });
						}
					}
					out[m.name] = ps;
					// The base's side is an unbiased sample of its tree: when a drop restores it, the next control reuses it.
					if (baseTree) runs.set(`${baseTree}\0${m.name}\0${m.cmd}`, { ts: L.clock.ms(), xs: ps.map(p => p[0]) });
				}
				return out;
			});
		} finally {
			await restore(root);
			progress?.("");
		}
	}

	// A proof is a deterministic check: it fails at the base and passes once the change works. Some replay a
	// whole call (~100s), so the cap is the metric default; once its runtime is known, a proof that runs far
	// longer than at registration has hung.
	const PROOF_MS = 600_000;
	// Its runtime at registration is a failing run, and passing can take longer: 5 minutes at least.
	const proofLimit = (proof: L.Proof) => (proof.ms ? Math.min(PROOF_MS, Math.max(300_000, 3 * proof.ms)) : PROOF_MS);
	async function proofRuns(root: string, cmd: string, goal: string, signal?: AbortSignal, limit = PROOF_MS): Promise<{ passed: number; out: string; broken?: string; ms: number }> {
		let passed = 0;
		let out = "";
		let broken: string | undefined; // the check could not run at all: timed out, or its command is missing
		let ms = 0;
		try {
			for (let i = 0; i < 2; i++) {
				const t0 = performance.now();
				const r = await run(root, cmd, limit, { phase: "proof", goal }, signal);
				ms = Math.max(ms, Math.round(performance.now() - t0));
				if (signal?.aborted) throw new Error("Proof interrupted; nothing was decided.");
				if (r.code === 0) passed++;
				else {
					out = said(r);
					if (r.killed) broken = `timed out after ${limit / 1000}s`;
					else if (r.code === 126 || r.code === 127) broken = `could not start (exit ${r.code}): ${out}`;
					if (broken) break; // a second try of a check that hung or cannot start only doubles the wait
				}
			}
		} finally {
			await restore(root);
		}
		return { passed, out, broken, ms };
	}

	async function hashes(root: string, files: string[]): Promise<Record<string, string>> {
		const out: Record<string, string> = {};
		for (const f of files) {
			const r = await git(root, "hash-object", "--", f);
			out[f] = r.code === 0 ? r.stdout.trim() : "missing";
		}
		return out;
	}

	/** Frozen instrument files changed between `from` and HEAD. */
	async function instrumentChanged(root: string, card: L.CardE, from: string | undefined): Promise<string[]> {
		if (!from || !card.frozen?.length) return [];
		// A file added under a frozen folder is not the instrument (what the commands run existed when it was frozen):
		// voice froze bench/, where every new proof lives, and each new proof forced a re-baseline.
		const r = await git(root, "diff", "--name-only", "--diff-filter=a", `${from}..HEAD`);
		return r.code === 0 ? X.touchedFrozen(r.stdout.split("\n").filter(Boolean), card.frozen) : [];
	}

	// One session drives a repo's climb. The holder renews the lease every tick;
	// another session takes over only when the holder has gone silent.
	const LEASE_STALE_MS = 4 * TICK_MS;
	// Keyed on the process, not the session id: /new or a session switch must not orphan the lease.
	const me = (_ctx: Ctx) => process.env.CLIMB_LEASE_ID ?? `${os.hostname()}:${process.pid}`;
	/** A holder on this machine whose process has exited: a restart takes over at once, not after the stale window. */
	function gone(who: string): boolean {
		const [host, pid] = who.split(":");
		if (host !== os.hostname() || !/^\d+$/.test(pid ?? "")) return false;
		try {
			process.kill(Number(pid), 0);
			return false;
		} catch (e) {
			return (e as { code?: string }).code === "ESRCH";
		}
	}
	function lease(root: string, ctx: Ctx, claim = false): boolean {
		const file = path.join(root, L.DIR, "lease.json");
		let cur: { who: string; ts: number } | undefined;
		try {
			cur = JSON.parse(fs.readFileSync(file, "utf8"));
		} catch {}
		const who = me(ctx);
		if (!claim && cur && cur.who !== who && L.clock.ms() - cur.ts < LEASE_STALE_MS && !gone(cur.who)) return false;
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, JSON.stringify({ who, ts: L.clock.ms() }));
		return true;
	}
	/** This session no longer climbs `root`: its lease goes now, not after the stale window. */
	function release(root: string, ctx: Ctx): void {
		const file = path.join(root, L.DIR, "lease.json");
		try {
			if ((JSON.parse(fs.readFileSync(file, "utf8")) as { who: string }).who === me(ctx)) fs.rmSync(file, { force: true });
		} catch {}
	}
	function holder(root: string, ctx: Ctx): void {
		if (!lease(root, ctx)) throw new Error("Another live session is driving this climb. The user's /climb resume in this session takes it over.");
	}

	// A guard that passed on this tree minutes ago passes again: retries skip the test suite.
	const guardPassed = kept("guardPassed", () => new Map<string, number>());
	async function guard(root: string, cmd: string | undefined, goal: string, signal?: AbortSignal): Promise<string | undefined> {
		if (!cmd) return undefined;
		const key = `${await tree(root)}\0${cmd}`;
		if (L.clock.ms() - (guardPassed.get(key) ?? -Infinity) < FRESH_MS) return undefined;
		let r = await run(root, cmd, 1_800_000, { phase: "guard", goal }, signal);
		await restore(root);
		// A guard that fails once and passes on a retry is flaky, not a verdict: pass, and say so.
		if (r.code !== 0 && !r.killed && !signal?.aborted) {
			const first = r;
			r = await run(root, cmd, 1_800_000, { phase: "guard", goal }, signal, true);
			await restore(root);
			if (r.code === 0)
				notices.push(`The guard failed once (exit ${first.code}: ${said(first).slice(-160)}) and passed on a retry: it is flaky. Keep network-bound or timing-sensitive checks out of the guard, or it will refuse good work.`);
		}
		if (signal?.aborted) throw new Error("Guard interrupted; nothing was decided and the experiment stays open.");
		if (r.code === 0) {
			guardPassed.set(key, L.clock.ms());
			return undefined;
		}
		// Untracked files are in the working tree every run sees, but in no commit: name them.
		const loose = (await git(root, "ls-files", "--others", "--exclude-standard", "--directory")).stdout.split("\n").filter(f => f && !f.startsWith(`${L.DIR}/`));
		const stray = loose.length ? `\nUntracked files took part in this run (no commit holds them): ${loose.slice(0, 8).join(", ")}${loose.length > 8 ? ` and ${loose.length - 8} more` : ""}.` : "";
		return `guard failed (exit ${r.code}): ${said(r)}${stray}`;
	}

	async function revert(root: string, exp: L.ExpE, reason: string): Promise<{ sha?: string; err?: string }> {
		// Restore the base tree exactly (handles merges and added files), then commit it.
		const r = await git(root, "restore", `--source=${exp.base}`, "--staged", "--worktree", ":/");
		if (r.code !== 0) return { err: said(r) };
		const c = await git(root, "commit", "-m", `revert: climb ${exp.id} (${exp.lever})`, "-m", reason.slice(0, 500));
		if (c.code !== 0 && !/nothing to commit/.test(c.stdout + c.stderr)) {
			await git(root, "reset", "-q", "--hard", "HEAD"); // undo only our staged restore; the tree was clean before
			return { err: said(c) || `git commit exit ${c.code}` };
		}
		return { sha: await head(root) };
	}

	// --- ledger writes + external tracking -----------------------------------------

	// Every ledger event also goes out: omp's event bus (channel "climb") for other
	// extensions, and CLIMB_SINK if set — an http(s) URL gets a JSON POST (Slack/
	// Discord webhooks read text/content), anything else is a shell command fed
	// the JSON on stdin. Fire-and-forget: tracking never blocks or breaks the climb.
	function append(root: string, ...entries: L.Entry[]): void {
		L.append(root, ...entries);
		for (const entry of entries) publish(root, entry);
	}

	function publish(root: string, entry: L.Entry): void {
		const text = X.describe(entry);
		const payload = { text, content: text, repo: path.basename(root), entry };
		try {
			pi.events?.emit("climb", payload);
		} catch {}
		const sink = process.env.CLIMB_SINK?.trim();
		if (!sink) return;
		const body = JSON.stringify(payload);
		if (/^https?:\/\//.test(sink)) {
			void fetch(sink, { method: "POST", headers: { "content-type": "application/json" }, body }).catch(e =>
				pi.logger?.warn?.("climb sink failed", { error: String(e) }),
			);
			return;
		}
		try {
			const child = spawn("bash", ["-c", sink], { cwd: root, stdio: ["pipe", "ignore", "ignore"] });
			child.on("error", () => {});
			child.stdin.on("error", () => {});
			child.stdin.end(`${body}\n`);
		} catch {}
	}

	// --- state + delivery --------------------------------------------------------

	const load = (root: string) => instruments(L.fold(L.read(root)));
	/** Marks goals whose instrument names a path that is gone with its folder (a deleted session scratchpad): an output
	 *  path the command writes still has its folder. Voice's parent goal measured with a backend in a scratchpad deleted days ago. */
	function instruments(st: L.State): L.State {
		for (const g of L.active(st)) {
			if (!g.card) continue;
			const paths = [...new Set([...g.card.metrics.map(m => m.cmd), g.card.guard ?? ""].flatMap(X.absolutePaths))];
			const lost = paths.filter(f => !SYSTEM.test(f) && !fs.existsSync(f) && !fs.existsSync(path.dirname(f)));
			if (lost.length) g.gone = lost.slice(0, 3);
		}
		return st;
	}

	function pick(st: L.State, id?: string, pred?: (g: L.Goal) => boolean, exact = false): L.Goal {
		const g = choose(st, id, pred, exact);
		mine.add(L.rootOf(st, g).id);
		return g;
	}
	function choose(st: L.State, id?: string, pred?: (g: L.Goal) => boolean, exact = false): L.Goal {
		const goals = L.active(st);
		if (id) {
			// A worker often shortens a goal id: one open goal starting with it is meant. Never a longer id,
			// which could name an ancestor (a part's slug extends its parent's).
			const near = exact ? [] : goals.filter(x => x.id.startsWith(id));
			const g = st.goals.get(id) ?? (near.length === 1 ? near[0] : undefined);
			if (g && !g.done) return g;
			const home = g?.parent ? st.goals.get(g.parent) : undefined;
			const reopen = g?.done && home && !home.done ? ` ${id} is closed (${g.done.result}); new work in its area is a new part: climb_split on ${home.id} with one part.` : g?.done ? ` ${id} is closed (${g.done.result}).` : "";
			throw new Error(`No active goal "${id}".${reopen} Active: ${goals.map(g => g.id).join(", ") || "none"}.`);
		}
		const leaves = goals.filter(g => !L.umbrella(st, g));
		const preferred = pred ? leaves.filter(pred) : [];
		const c = preferred.length ? preferred : leaves;
		if (c.length === 1) return c[0];
		// Goals other sessions left behind are not this session's: the one it started or named is meant.
		const ours = c.filter(g => mine.has(L.rootOf(st, g).id));
		if (ours.length === 1) return ours[0];
		// A STUCK tree waits for the user: after a restart, the one goal still climbing is meant.
		const live = c.filter(g => !L.stuck(L.rootOf(st, g)));
		if (live.length === 1) return live[0];
		if (c.length) throw new Error(`Several active goals; pass goal: ${c.map(g => g.id).join(", ")}.`);
		throw new Error("No active climb goal. The user starts one with /climb <intent>.");
	}

	/** A part that closes may close its parent: achieved when every part is and the acceptance review
	 *  agrees the parent's own intent is met. Returns the goals closed. */
	async function rollUp(ctx: Ctx, root: string, id: string): Promise<string[]> {
		const closed: string[] = [];
		let st = load(root);
		for (let g = st.goals.get(id); g?.parent; g = st.goals.get(g.parent)) {
			const parent = st.goals.get(g.parent);
			if (!parent || parent.done) break;
			// Abandoned parts were dropped (by the user): the rest decide, and the review checks the parent's intent.
			const ps = L.parts(st, parent).filter(c => c.done?.result !== "abandoned");
			if (!ps.length || !ps.every(c => c.done?.result === "achieved")) break;
			const r = await review(ctx, root, parent);
			if (typeof r === "string" && parent.reviewed) break;
			if (typeof r === "object" && !r.achieved) {
				append(root, { ts: L.now(), kind: "judge", goal: parent.id, by: "judge", review: true, verdict: "continue", diagnosis: `Every part is achieved, but not the intent: ${r.unmet}`, next: r.next });
				break;
			}
			append(root, { ts: L.now(), kind: "done", goal: parent.id, result: "achieved", values: {}, unreviewed: typeof r === "string" ? r : undefined });
			closed.push(parent.id);
			st = load(root);
		}
		return closed;
	}

	/** Every target met and confirmed: the acceptance review decides. Achieved closes the goal (and
	 *  maybe its parents); otherwise what is missing is recorded and the goal stays open. */
	async function accept(ctx: Ctx, root: string, g: L.Goal, values: L.Values): Promise<{ unmet?: { unmet: string; next: string }; closedUp: string[] }> {
		const r = await review(ctx, root, g);
		// A review that cannot run does not hold a goal open (the closure says it was not reviewed),
		// unless it already held this one: then only it can release it.
		if (typeof r === "string" && g.reviewed)
			return { unmet: { unmet: "the acceptance review could not run this time, and it held this goal before, so the goal stays open", next: "ask it again: climb_scorecard with the same checks" }, closedUp: [] };
		if (typeof r === "object" && !r.achieved) {
			append(root, { ts: L.now(), kind: "judge", goal: g.id, by: "judge", review: true, verdict: "continue", diagnosis: `Every target is met, but not the intent: ${r.unmet}`, next: r.next });
			return { unmet: r, closedUp: [] };
		}
		append(root, { ts: L.now(), kind: "done", goal: g.id, result: "achieved", values, unreviewed: typeof r === "string" ? r : undefined });
		return { closedUp: await rollUp(ctx, root, g.id) };
	}
	/** Holds that look regressed against the card they were set on, checked against that card's commit
	 *  interleaved: the machine drifts between then and now, and only pairs tell drift from a regression.
	 *  What really regressed, as text; undefined when nothing did. */
	async function holdsSlid(root: string, card: L.CardE, values: L.Values, goal: string, signal: AbortSignal | undefined, say: Progress): Promise<string | undefined> {
		const looks = card.metrics.filter(m => m.hold && values[m.name] !== undefined && !L.met(m, values[m.name]));
		if (!looks.length) return undefined;
		const raw = looks.map(m => `${m.name} ${+m.baseline.toPrecision(6)}→${+values[m.name].toPrecision(6)}`).join(", ");
		const pairs = card.head ? await paired(root, card.head, looks, goal, signal, t => say(t && `paired check of ${looks.map(m => m.name).join(", ")} against the scorecard's commit: ${t}`)) : undefined;
		if (typeof pairs === "string") return `${raw} looks regressed, and the paired check could not finish (${pairs})`;
		if (!pairs) return `${raw} looks regressed (the scorecard's commit could not be measured alongside)`;
		const pv = X.pairedVerdict(looks, pairs);
		return pv.regressed ? `${raw} regressed beyond its tolerance since the scorecard (${pv.reason})` : undefined;
	}
	const unmetText = (u: { unmet: string; next: string }) =>
		`EVERY TARGET MET, BUT THE INTENT IS NOT DONE (acceptance review): ${u.unmet}\nNEXT: ${u.next}. Put what is missing on the scorecard next to the current metrics (climb_scorecard; a check that already passes is welcome: when every metric meets its target there, the review is asked again).`;
	function achievedText(st: L.State, ctx: Ctx, g: L.Goal, closedUp: string[]): string {
		// Closed without the acceptance review: said here, on the panel and in the export, never passed off as reviewed.
		const why = st.goals.get(g.id)?.done?.unreviewed;
		const unchecked = [g.id, ...closedUp].filter(id => st.goals.get(id)?.done?.unreviewed);
		const caveat = unchecked.length ? ` Nothing checked the intent beyond the scorecard for ${unchecked.join(" and ")}: the acceptance review did not run (${why ?? st.goals.get(unchecked[0])?.done?.unreviewed}).` : "";
		let text = `GOAL ACHIEVED: ${g.id}, every target met.${g.card?.parked?.length ? ` Parked metrics remain: ${g.card.parked.join(", ")}.` : ""}${closedUp.length ? ` That completes ${closedUp.join(" and ")}: every part achieved.` : ""}${caveat}`;
		const rest = L.roots(st);
		if (rest.length) text += `\n${rest.map(r => X.nextAction(st, r)).join("\n")}`;
		ctx.ui?.notify?.(`climb ${g.id} achieved${unchecked.length ? `, unreviewed: the acceptance review did not run (${why ?? st.goals.get(unchecked[0])?.done?.unreviewed})` : ""}`, unchecked.length ? "warning" : "info");
		if (!L.active(st).length) stopTimer(ctx);
		return text;
	}

	function refresh(ctx: Ctx, root: string): L.State {
		const st = load(root);
		const line = X.statusLine(st);
		ctx.ui?.setStatus?.("climb", line && staleCode ? `${line} · ↻ restart omp to update climb` : line);
		return st;
	}

	/** Checked on the heartbeat: a newer climb on disk is loaded only by a new session. */
	function checkUpdate(ctx: Ctx): void {
		// Hosted by src/omp.ts (or Claude Code's host), a newer climb swaps itself in: there is nothing to restart.
		if ((pi as { hot?: boolean }).hot || (pi as { harness?: string }).harness === "claude-code") return;
		if (staleCode || !loadedStamp || sourceStamp() <= loadedStamp + 1000) return;
		staleCode = true;
		ctx.ui?.notify?.("climb: a newer version is installed. Restart omp (/exit, then omp -c) to load it; the climb resumes from its ledger.", "info");
	}

	function deliver(ctx: Ctx, text: string, trigger: boolean): void {
		const msg = { customType: "climb", content: text, display: true };
		if (ctx.isIdle()) pi.sendMessage(msg, { triggerTurn: trigger });
		else pi.sendMessage(msg, { deliverAs: omp ? "aside" : "steer" });
	}

	// One measurement at a time: concurrent benchmarks corrupt each other's numbers.
	let measuring: Promise<unknown> = Promise.resolve();
	/** Climb tools measuring right now. */
	let inFlight = 0;
	function exclusive<T>(fn: () => Promise<T>): Promise<T> {
		const counted = async () => {
			inFlight++;
			try {
				return await fn();
			} finally {
				inFlight--;
			}
		};
		const run = measuring.then(counted, counted);
		measuring = run.catch(() => {});
		return run;
	}

	const ok = (text: string) => ({ content: [{ type: "text" as const, text: text + artifactNote() }] });

	/** Every climb tool call is traced with its duration and, when refused, why: refusals
	 *  never reach the ledger, yet they are where a climb quietly loses its hours. */
	function logged<P, R>(tool: string, fn: (id: string, p: P, signal: AbortSignal | undefined, onUpdate: Update | undefined, ctx: Ctx) => Promise<R>) {
		return async (id: string, p: P, signal: AbortSignal | undefined, onUpdate: Update | undefined, ctx: Ctx): Promise<R> => {
			const t0 = performance.now();
			const c0 = L.clock.ms();
			const note = async (ok: boolean, error?: string) => {
				const root = await repoRoot(ctx.cwd).catch(() => undefined);
				if (root && fs.existsSync(path.join(root, L.DIR)))
					T.append(root, { ts: L.now(), kind: "tool", goal: (p as GoalParam | undefined)?.goal, tool, ms: Math.round(performance.now() - t0), ok, error: error?.slice(0, 300) });
			};
			try {
				const r = await fn(id, p, signal, onUpdate, ctx);
				await note(true);
				return r;
			} catch (e) {
				const ms = L.clock.ms() - c0;
				// Cut off after minutes of measuring: most likely a caller's timeout (voice's eval cell, at 3600 s), not a person.
				if (signal?.aborted && ms >= 300_000 && e instanceof Error && /interrupted/.test(e.message))
					e.message += ` It was cut off after ${Math.round(ms / 60_000)} min: if eval or a script called it, its timeout stopped it (eval stops a cell at one hour). Call ${tool} directly; a direct call runs to the end.`;
				await note(false, e instanceof Error ? e.message : String(e));
				throw e;
			}
		};
	}

	const efficiency = (root: string) => T.stats(T.read(root), L.read(root), L.clock.ms());

	/** Where a scorecard's history starts: runs since then (its own A/A included) measure its metrics. */
	function cardSince(root: string, g: L.Goal): number {
		const cards = L.read(root).filter((e): e is L.CardE => e.kind === "card" && e.goal === g.id);
		const cur = cards.at(-1);
		const prev = cards.at(-2);
		return Math.max(prev ? L.epoch(prev.ts) : L.epoch(g.created), cur ? L.epoch(cur.ts) - 2 * 3_600_000 : 0);
	}

	/** The scorecard with each metric's noise raised to what its run history shows: back-to-back A/A
	 *  runs see one calm moment, while runs of unchanged code across hours also see drift and load. */
	function effective(root: string, g: L.Goal, traces = T.read(root)): { metrics: L.Metric[]; notes: string[] } {
		const since = cardSince(root, g);
		const notes: string[] = [];
		const metrics = g.card!.metrics.map(m => {
			const p = T.pooledSd(traces, g.id, m.name, since, cmdId(m.cmd));
			const n = p ? X.noiseFromSd(p.sd, m.samples) : 0;
			if (n <= m.noise) return m;
			notes.push(`${m.name} noise re-estimated at ±${(n * 100).toFixed(1)}% from ${p!.runs} runs of ${p!.trees} unchanged trees (the scorecard's A/A said ±${(m.noise * 100).toFixed(1)}%)`);
			return { ...m, noise: n };
		});
		return { metrics, notes };
	}

	/** Target metrics whose last pairs on their current command were noisier than the whole way to the target:
	 *  no step on them can be told apart from luck. Pairs measured under an earlier scorecard with the same
	 *  command count, so re-scoring alone does not hide them. */
	function deaf(root: string, g: L.Goal): { m: L.Metric; noise: number; way: number; n: number }[] {
		const cmds = new Map<string, string>();
		const last = new Map<string, [number, number][]>();
		for (const e of L.read(root)) {
			if (e.goal !== g.id) continue;
			if (e.kind === "card") for (const m of e.metrics) cmds.set(m.name, m.cmd);
			else if (e.kind === "result") for (const [k, ps] of Object.entries(e.paired ?? {})) if (ps.length && cmds.has(k)) last.set(`${k}\0${cmds.get(k)}`, ps);
		}
		return g.card!.metrics.flatMap(m => {
			const ps = last.get(`${m.name}\0${m.cmd}`);
			if (m.hold || !ps) return [];
			// Deaf is what the most pairs it may get would still show: a result paired fewer times is no verdict on the instrument.
			const noise = X.pairNoiseAt(m, ps);
			const way = L.gain(m, m.baseline, m.target);
			return noise >= way ? [{ m, noise, way, n: X.PAIRS }] : [];
		});
	}
	const STEADY =
		"Steady the instrument, then re-baseline with climb_scorecard: average over more cases per run, fix the inputs, and look for runs that land in two clusters (a median of two-mode data flips between them; a mean or each mode's share does not).";

	/** .climb/export.json: the ledger as evidence rows (benchmaxx schema), rewritten after every decision. */
	async function writeExport(root: string, file = path.join(root, L.DIR, "export.json")): Promise<{ file: string; rows: number; findings: number }> {
		if (!remotes.has(root)) remotes.set(root, (await git(root, "remote", "get-url", "origin")).stdout.trim().replace(/\/\/[^@/]*@/, "//") || undefined);
		const repo = { name: path.basename(root), remote: remotes.get(root) };
		const out = E.build(L.read(root), repo, L.clock.ms());
		try {
			fs.mkdirSync(path.dirname(file), { recursive: true });
			const tmp = `${file}.${process.pid}.tmp`;
			fs.writeFileSync(tmp, JSON.stringify(out, null, 1));
			fs.renameSync(tmp, file);
		} catch (e) {
			pi.logger?.warn?.("climb export failed", { error: String(e) });
		}
		// The same evidence, readable: .climb/panel.html (open it in a browser).
		try {
			const page = path.join(root, L.DIR, "panel.html");
			fs.writeFileSync(`${page}.${process.pid}.tmp`, P.render(load(root), out, T.summary(T.read(root), L.read(root), L.clock.ms()), L.clock.ms()));
			fs.renameSync(`${page}.${process.pid}.tmp`, page);
		} catch (e) {
			pi.logger?.warn?.("climb panel failed", { error: String(e) });
		}
		return { file, rows: out.metric_rows.length, findings: out.knowledge.length };
	}
	const remotes = new Map<string, string | undefined>();

	// A turn queued from a command starts asynchronously. Headless hosts (print/json)
	// exit once idle, so hold the command until that turn is actually running; the
	// host then waits for it, stop-hook continuations included.
	async function started(ctx: Ctx): Promise<void> {
		const mode = (ctx as { mode?: string }).mode;
		if (mode === "tui" || mode === "rpc") return;
		for (let i = 0; i < 200 && ctx.isIdle(); i++) await new Promise(r => setTimeout(r, 50));
	}

	function worker(ctx: Ctx): void {
		ctxRef = ctx;
		if (ctx.agent?.kind === "sub") throw new Error("climb tools belong to the main worker, not subagents. Report back to it instead.");
	}

	// --- heartbeat ---------------------------------------------------------------

	function ensureTimer(ctx: Ctx): void {
		if (timer !== undefined) return;
		const fn = () => {
			void tick(ctxRef ?? ctx).catch(e => pi.logger?.warn?.("climb heartbeat failed", { error: String(e) }));
		};
		if (typeof ctx.setInterval === "function") timer = ctx.setInterval(fn, TICK_MS);
		else {
			const t = setInterval(() => {
				try {
					fn();
				} catch {}
			}, TICK_MS);
			(t as { unref?: () => void }).unref?.();
			timer = t;
		}
	}

	function stopTimer(ctx: Ctx): void {
		if (timer === undefined) return;
		if (typeof ctx.clearTimer === "function") ctx.clearTimer(timer as never);
		else clearInterval(timer as ReturnType<typeof setInterval>);
		timer = undefined;
	}

	async function tick(ctx: Ctx, force = false): Promise<void> {
		if (beating) return;
		beating = true;
		try {
			const root = await repoRoot(ctx.cwd);
			if (!root) return;
			let st = load(root);
			if (st.lines > 2000) {
				L.rewrite(root, L.compact(L.read(root)));
				st = load(root);
			}
			T.cap(root);
			// Parts are audited through their root: one heartbeat, one stall count, one judge per tree.
			const goals = L.roots(st);
			if (!goals.length) {
				stopTimer(ctx);
				ctx.ui?.setStatus?.("climb", undefined);
				return;
			}
			checkUpdate(ctx);
			if ((st.paused && !force) || !lease(root, ctx, force)) return void refresh(ctx, root);
			for (const g of goals) {
				const since = L.clock.ms() - L.epoch(g.lastBeat?.ts ?? g.created);
				const beatMs = g.cfg.beat_s * 1000;
				const idle = ctx.isIdle();
				if (!force && (since < beatMs || (!idle && since < 2 * beatMs))) continue;
				const fresh = load(root).goals.get(g.id);
				if (!fresh || fresh.done) continue;
				if (!force && fresh.lastBeat && L.clock.ms() - L.epoch(fresh.lastBeat.ts) < beatMs / 2) continue; // another session beat it
				await beat(ctx, root, fresh, idle, st.paused);
			}
			refresh(ctx, root);
		} finally {
			beating = false;
		}
	}

	/** A part for the requirement the acceptance review found unchecked, under the goal it held open (or beside it, at the
	 *  deepest level). False when there is nothing to steer: no review hold, a part for it exists, or no room for one. */
	function steer(ctx: Ctx, root: string, top: L.Goal): boolean {
		const st = load(root);
		const held = L.subtree(st, top).find(x => x.reviewed && X.finishing(st, x));
		if (!held?.reviewed) return false;
		const mark = `auto-steer ${held.reviewed.ts}`;
		const home = L.depth(st, held) < X.MAX_DEPTH ? held : held.parent ? st.goals.get(held.parent) : undefined;
		if (!home || L.subtree(st, home).some(x => x.why?.startsWith(mark)) || L.openParts(st, home).length >= X.MAX_PARTS) return false;
		const unmet = held.reviewed.diagnosis.replace(/^Every (target is met|part is achieved), but not the intent: /, "");
		const intent = `${held.reviewed.next.replace(/[.\s]+$/, "")} (the acceptance review of ${held.id}: ${unmet})`.slice(0, 600);
		const id = X.slug(intent, new Set(st.goals.keys()));
		append(root, { ts: L.now(), kind: "goal", goal: id, intent, cfg: home.cfg, parent: home.id, why: `${mark}: the review held ${held.id} open and nothing answered it`, harness });
		const part = refresh(ctx, root).goals.get(id)!;
		ctx.ui?.notify?.(`climb auto-steer: the acceptance review held ${held.id} open and the worker had not answered it; ${id} is now a part that checks it.`, "info");
		deliver(ctx, `[climb auto-steer] The acceptance review held ${held.id} open: ${unmet}. That requirement is now a part of ${home.id}: ${id}.\n${X.researchBrief(part)}`, true);
		return true;
	}

	async function beat(ctx: Ctx, root: string, g: L.Goal, idle: boolean, paused: boolean): Promise<void> {
		// The heartbeat audits the ledger; it never measures. Measuring here would race the
		// worker's edits and its benchmarks, and only kept results move the climb anyway.
		const h = (await head(root)) ?? "";
		const st = load(root);
		const busy = X.openIn(st, g);
		const note = busy ? `${busy.open!.id} open${busy !== g ? ` on ${busy.id}` : ""}` : !g.card && !L.umbrella(st, g) ? "no scorecard yet" : !idle ? "worker busy" : undefined;
		const progress = L.treeProgressSinceBeat(st, g);
		// An independent verdict restarts the count, so the judge runs once per stall, not every beat. An hour the
		// extension spends measuring is its own instrument's time, not the worker's: it holds the count.
		const count = L.judgedSinceBeat(g) ? 0 : (g.lastBeat?.stale ?? 0);
		const stale = progress ? 0 : inFlight ? count : count + 1;
		append(root, { ts: L.now(), kind: "beat", goal: g.id, head: h, progress, stale, note: inFlight ? `${note ? `${note} · ` : ""}measuring` : note });

		const after = load(root).goals.get(g.id)!;
		if (paused || L.stuck(after)) return;
		// Auto-steer: a goal the acceptance review held open, while the worker lets the stale beats pile up, gets a part
		// for the review's unmet requirement, so the climb goes on without waiting for anyone (pry sat at 100% · review
		// holds it · stale 20/3 until a judge called it STUCK).
		if (stale >= g.cfg.poke_max && !after.stallPending && steer(ctx, root, after)) return;
		if (stale >= g.cfg.poke_max && !after.stallPending) {
			append(root, { ts: L.now(), kind: "stall", goal: g.id, stale });
			void judge(ctx, root, g.id, "stall");
			return;
		}
		const line = `[climb heartbeat ${g.id}] ${progress ? "progress" : `no progress (stale ${stale}/${g.cfg.poke_max})`}${note ? ` · ${note}` : ""}`;
		if (idle) {
			const now = load(root);
			deliver(ctx, `${line}\n${X.nextAction(now, now.goals.get(g.id)!)}`, true);
		}
		else if (!progress) deliver(ctx, line, false);
	}

	/** One independent side turn, outside the worker's history. Transports differ in what side turns accept
	 *  (output caps, tool opt-out), so it degrades; a hung turn must not hold a gate shut, so one deadline
	 *  covers all attempts. Throws when every attempt failed (and marks the judge broken). */
	async function sideTurn(turn: NonNullable<Ctx["runEphemeralTurn"]>, promptText: string): Promise<string> {
		let lastErr: unknown;
		const deadline = Date.now() + JUDGE_MS;
		for (const opts of [{ tools: false as const, maxTokens: 1500 }, { tools: false as const }, {}]) {
			const left = deadline - Date.now();
			if (left <= 0) break;
			let timer: ReturnType<typeof setTimeout> | undefined;
			const attempt = Promise.resolve().then(() => turn({ promptText, ...opts }));
			const late = new Promise<never>((_, no) => (timer = setTimeout(() => no(new Error(`judge timed out after ${JUDGE_MS / 60_000} minutes`)), left)));
			attempt.catch(() => {}); // the loser of the race must not surface as an unhandled rejection
			late.catch(() => {});
			try {
				const reply = (await Promise.race([attempt, late])).replyText;
				judgeBroken = false;
				return reply;
			} catch (e) {
				lastErr = e;
			} finally {
				clearTimeout(timer);
			}
		}
		judgeBroken = true;
		throw lastErr ?? new Error("judge timed out");
	}

	/** Before a goal closes on met targets, an independent check that its intent is met too: a scorecard
	 *  can be achieved while a requirement of the intent never made it onto it. A string: why it could not run. */
	async function review(ctx: Ctx, root: string, g: L.Goal): Promise<{ achieved: boolean; unmet: string; next: string } | string> {
		const turn = ctx.runEphemeralTurn?.bind(ctx);
		if (!turn) return "no independent review on this host";
		const t0 = performance.now();
		try {
			const st = load(root);
			const log = (await git(root, "log", "--oneline", "-15")).stdout.trim();
			const reply = await sideTurn(turn, X.reviewPrompt(st, st.goals.get(g.id) ?? g, log));
			T.append(root, { ts: L.now(), kind: "judge", goal: g.id, ms: Math.round(performance.now() - t0), ok: true, why: "acceptance review" });
			return X.parseReview(reply);
		} catch (e) {
			T.append(root, { ts: L.now(), kind: "judge", goal: g.id, ms: Math.round(performance.now() - t0), ok: false, error: String(e).slice(0, 300), why: "acceptance review" });
			return `it failed: ${String(e).slice(0, 160)}`; // a review that cannot run does not hold the goal open
		}
	}

	async function judge(ctx: Ctx, root: string, id: string, why: string): Promise<void> {
		if (judging.has(id)) return;
		judging.add(id);
		const t0 = performance.now();
		const mark = (ok: boolean, error?: string) =>
			T.append(root, { ts: L.now(), kind: "judge", goal: id, ms: Math.round(performance.now() - t0), ok, error: error?.slice(0, 300), why });
		try {
			const g = load(root).goals.get(id);
			if (!g || g.done) return;
			// Always retry the judge itself; judgeBroken only decides who may clear the gate meanwhile.
			const turn = ctx.runEphemeralTurn?.bind(ctx);
			if (!turn) return deliver(ctx, `${X.nextAction(load(root), g)} No independent judge on this host: call climb_judge with an honest diagnosis.`, true);
			const log = (await git(root, "log", "--oneline", "-15")).stdout.trim();
			const tree = new Set(L.subtree(load(root), g).map(x => x.id));
			const promptText = X.judgePrompt(load(root), g, L.read(root).filter(e => tree.has(e.goal) && e.kind !== "beat" && e.kind !== "rollup").slice(-15), log, T.stats(T.read(root), L.read(root), L.clock.ms()));
			const reply = await sideTurn(turn, promptText);
			mark(true);
			const j = X.parseJudge(reply);
			append(root, { ts: L.now(), kind: "judge", goal: id, by: "judge", ...j });
			const msg = `[climb JUDGE ${id}] ${j.verdict.toUpperCase()}: ${j.diagnosis}\nNEXT: ${j.next}`;
			if (j.verdict === "stuck") ctx.ui?.notify?.(`climb ${id} is STUCK and needs you: ${j.diagnosis}`, "warning");
			deliver(ctx, msg, j.verdict !== "stuck");
			refresh(ctx, root);
		} catch (e) {
			pi.logger?.warn?.("climb judge failed", { error: String(e) });
			mark(false, String(e));
			const g = load(root).goals.get(id);
			// Never leave the worker gated on a judge that cannot answer.
			if (g && !g.done) deliver(ctx, `${X.nextAction(load(root), g)} The independent judge failed (${String(e).slice(0, 160)}): call climb_judge with an honest diagnosis.`, true);
		} finally {
			judging.delete(id);
		}
	}

	// --- enforcement hooks ---------------------------------------------------------

	pi.on("session_start", async (_e, ctx) => {
		if (ctx.agent?.kind === "sub") return;
		ctxRef = ctx;
		const root = await repoRoot(ctx.cwd);
		if (!root) return;
		const st = refresh(ctx, root);
		const goals = L.active(st);
		if (goals.length) ensureTimer(ctx);
		// A restart can kill a judge mid-verdict: a pending stall must not wait on it forever.
		// Only then is the lease touched: opening omp in an unrelated repo writes nothing.
		const orphaned = goals.filter(g => g.stallPending && !judging.has(g.id));
		if (!st.paused && orphaned.length && hasJudge(ctx) && lease(root, ctx))
			for (const g of orphaned) void judge(ctx, root, g.id, "stall left without a verdict (restart)");
	});

	pi.on("turn_end", async (_e, ctx) => {
		if (ctx.agent?.kind !== "sub") ctxRef = ctx;
	});

	// A session that ends, or hands over to a newer climb (Claude Code's hot update), stops its heartbeat.
	pi.on("session_shutdown", async () => {
		if (ctxRef) stopTimer(ctxRef);
	});

	pi.on("session_stop", async (_e, ctx) => {
		if (ctx.agent?.kind === "sub") return;
		ctxRef = ctx;
		const root = await repoRoot(ctx.cwd);
		if (!root) return;
		const st = load(root);
		// A part rests with its root: a STUCK or judged tree does not hold the worker.
		// A tree whose every open goal lost its instrument cannot be climbed: it rests with the user, like STUCK.
		const climbable = (r: L.Goal) => L.subtree(st, r).some(x => !x.done && !x.moved && !x.gone?.length && !L.umbrella(st, x));
		const goals = L.active(st).filter(g => !L.stuck(L.rootOf(st, g)) && climbable(L.rootOf(st, g)) && !judging.has(L.rootOf(st, g).id) && !judging.has(g.id));
		if (st.paused || !goals.length || !lease(root, ctx)) {
			stopIdle = 0;
			stopLines = -1;
			return;
		}
		// A worker that keeps stopping without touching the ledger is not working;
		// let it rest and leave the next nudge to the heartbeat. Repeated rests with
		// no progress escalate to the human.
		stopIdle = st.lines === stopLines ? stopIdle + 1 : 0;
		stopLines = st.lines;
		if (stopIdle >= 2) {
			stopIdle = 0;
			stopLines = -1;
			const progress = Math.max(...goals.map(g => g.progressSeq));
			rests = progress === restProgress ? rests + 1 : 1;
			restProgress = progress;
			if (rests >= 3) {
				ctx.ui?.notify?.(`climb: the worker keeps stopping without progress (${rests} rests). It needs your direction.`, "warning");
				return;
			}
			// A worker that stops without working needs direction, not a 30-minute nap.
			ctx.ui?.notify?.("climb: worker stopped twice without touching the ledger; asking the judge for direction.", "info");
			for (const g of goals) void judge(ctx, root, g.id, "worker kept stopping idle");
			return;
		}
		return { decision: "block" as const, reason: [...new Set(goals.map(g => L.rootOf(st, g)))].map(g => X.nextAction(st, g, true)).join("\n") };
	});

	// Survive host compaction: the summary always carries the authoritative climb state.
	pi.on("session.compacting", async (_e, ctx) => {
		if (ctx.agent?.kind === "sub") return;
		const root = await repoRoot(ctx.cwd);
		if (!root) return;
		const st = load(root);
		const goals = L.active(st);
		if (!goals.length) return;
		const known = goals.flatMap(g => g.learned).slice(-20);
		return {
			context: [
				`Climb state (authoritative, from ${L.DIR}/${L.FILE}):\n${X.report(st)}\n${L.roots(st).map(g => X.nextAction(st, g)).join("\n")}${known.length ? `\nRecorded knowledge:\n${known.map(l => `- [${l.type}] ${l.text}`).join("\n")}` : ""}`,
			],
		};
	});

	pi.on("tool_call", async (event, ctx) => {
		const input = JSON.stringify(event.input ?? {});
		if (event.toolName === "bash" && /git\s+clean\b[^"]*\s-\w*[xX]/.test(input))
			return { block: true, reason: "git clean -x/-X would delete the climb ledger (.climb/)." };
		const editing = /^(write|edit|apply_patch|ast_edit|notebook)$/.test(event.toolName);
		const at0 = (event.input ?? {}) as Record<string, unknown>;
		const files = Object.entries(at0)
			.filter(([k, v]) => /path|file/i.test(k) && typeof v === "string")
			.map(([, v]) => realish(path.resolve(ctx.cwd, v as string)));
		// While climb measures its checkout, nothing may change it. Everything else goes on: reading, research,
		// drafts and work outside it (voice's worker sat idle through every 8-minute measurement, all commands refused).
		if (inFlight && (editing || event.toolName === "bash")) {
			const root = await repoRoot(ctx.cwd);
			const cwd = typeof at0.cwd === "string" && at0.cwd ? at0.cwd : ctx.cwd;
			const inside = (f: string) => !!root && (f === root || f.startsWith(`${root}/`));
			const hits = editing ? (event.toolName === "apply_patch" || !files.length ? !!root : files.some(inside)) : !!root && X.changesTree(String(at0.command ?? ""), root, realish(cwd), os.homedir(), realish);
			if (hits)
				return {
					block: true,
					reason: `climb is measuring ${root} right now: a change there would be measured with it. Reading, research and work outside it go on; draft the next change in a scratch file and apply it once the result arrives.`,
				};
			// A second run of the instrument itself (voice's worker ran its call bench by hand on another port) loads the
			// machine and the APIs the measurement runs on: it waits. Tests, proofs and other scripts do not.
			if (root && event.toolName === "bash") {
				const cards = L.active(load(root)).flatMap(g => (g.card ? [g.card] : []));
				const scripts = new Set(cards.flatMap(c => c.metrics.flatMap(m => X.instrumentFiles(m.cmd, new Set(c.frozen ?? [])))));
				const again = X.instrumentFiles(String(at0.command ?? ""), scripts);
				if (again.length)
					return {
						block: true,
						reason: `climb is measuring with ${again.join(", ")} right now: another run of it would load the machine and the services it measures, and the numbers being decided would carry that. Run it once the result arrives; until then, read, research or prepare the next change.`,
					};
			}
		}
		if (X.namesDir(input, L.DIR)) {
			// The edit's target, not its text: a test or a doc that mentions the ledger is not the ledger. A patch names its files inside.
			const at = event.input as { path?: unknown; file_path?: unknown; notebook_path?: unknown; command?: unknown } | undefined;
			const target = [at?.path, at?.file_path, at?.notebook_path].filter((p): p is string => typeof p === "string");
			if (editing && (event.toolName === "apply_patch" || !target.length || target.some(p => X.writesLedger(`> ${p}`, L.DIR)))) return { block: true, reason: LEDGER_GUARD };
			// Only a write into the ledger: a read whose redirect goes elsewhere ("2>/dev/null") was refused too.
			if (event.toolName === "bash" && X.writesLedger(typeof at?.command === "string" ? at.command : input, L.DIR)) return { block: true, reason: LEDGER_GUARD };
			if (!editing) return;
		}
		// Freeze rule: while an experiment is open its instrument cannot change.
		if (!editing || ctx.agent?.kind === "sub") return;
		const root = await repoRoot(ctx.cwd);
		if (!root) return;
		const open = L.active(load(root)).find(g => g.open);
		const frozen = [...(open?.card?.frozen ?? []), ...Object.keys(open?.open?.proof?.files ?? {})];
		if (!open?.open || !frozen.length) return;
		const real = (p: string) => {
			try {
				return path.join(fs.realpathSync(path.dirname(p)), path.basename(p));
			} catch {
				return p;
			}
		};
		const paths = Object.entries((event.input ?? {}) as Record<string, unknown>)
			.filter(([k, v]) => /path|file/i.test(k) && typeof v === "string")
			.map(([, v]) => path.relative(real(root), real(path.resolve(ctx.cwd, v as string))));
		const hit = X.touchedFrozen(paths, frozen);
		if (hit.length)
			return {
				block: true,
				reason: `${hit.join(", ")} is part of the frozen instrument (scorecard or proof) of ${open.id} while ${open.open.id} is open. Finish the experiment first; to change the instrument, re-baseline with climb_scorecard afterwards.`,
			};
	});

	// --- worker tools ----------------------------------------------------------------

	pi.registerTool({
		name: "climb_scorecard",
		label: "Climb: scorecard",
		description:
			"Define or replace the scorecard of a climb goal: 1-3 metrics (focus on the few that matter; park the rest). Each metric is a shell command run from the repo root whose output's last number is the value, or its own `name=value` line: metrics with one command share each run (a bench printing three numbers runs once, not three times). The extension runs every command itself to measure the baseline on the current commit (the working tree must be clean). Optional guard: a command (usually the test suite) that must exit 0 for any experiment to be kept." + DIRECT,
		parameters: S.obj({
			goal: S.opt(S.str("Goal id; optional when one goal is active")),
			metrics: S.arr(
				S.obj({
					name: S.str("snake_case metric name"),
					cmd: S.str("Shell command printing the value as its last number"),
					dir: S.enum(["up", "down"], "Which direction is better"),
					target: S.opt(S.num("Ambitious target value (omit for hold metrics)")),
					hold: S.opt(S.bool("Constraint, not a goal (e.g. 'no slower'): must not regress beyond noise; no target")),
					unit: S.opt(S.str("Unit label, e.g. ms")),
					noise: S.opt(S.num("Floor for the relative noise; default 0.01. The real noise is measured by A/A runs")),
					samples: S.opt(S.num("Runs per measurement, median taken; default 1, max 9. Noise shrinks with √samples: the lever for a noisy metric")),
					timeout_s: S.opt(S.num("Per-run timeout in seconds; default 600")),
					parallel: S.opt(S.num("Runs of this metric that may go at once, each with its own $CLIMB_SLOT (0, 1, ...) for its port or other exclusive resource, e.g. --port=$((8875 + CLIMB_SLOT)). 2: a pair's base and candidate at once (half the time; drift cancels exactly). 4: two pairs at once, and four samples at once in plain runs. Up to 8")),
				}),
				"1-3 metrics. Metrics with the same cmd share each run: the command prints one `name=value` line per metric",
			),
			guard: S.opt(S.str("Command that must exit 0 at every kept result, e.g. the test suite")),
			frozen: S.opt(
				S.arr(
					S.str("path or glob"),
					"Instrument paths experiments may not change (bench scripts, fixtures, tests). Omit to freeze the scripts the metric and guard commands execute; pass [] when the goal is to change them (e.g. adding tests).",
				),
			),
			parked: S.opt(S.arr(S.str("metric"), "Metrics worth tracking later, not now")),
			axioms: S.opt(S.arr(S.str("axiom"), "Why these metrics")),
			own_checkout: S.opt(S.bool("true when this checkout's uncommitted changes are not this goal's (another session's or the user's): the goal moves to a checkout of its own beside it, and this session follows it with no restart")),
		}),
		loadMode: "essential",
		execute: logged("climb_scorecard", (_id, p: ScorecardParams, signal, onUpdate, ctx) => exclusive(async () => {
			worker(ctx);
			let root = await needRoot(ctx);
			holder(root, ctx);
			let g = pick(load(root), p.goal);
			if (g.open) throw new Error(`Experiment ${g.open.id} is open; close it with climb_measure before changing the scorecard.`);
			// A goal climbs where its instrument runs, in a checkout no other work touches: a goal started in a shared
			// checkout (platinum-dev, another agent's edit uncommitted) whose commands cd into a design repo was refused there for an hour.
			const into = p.metrics?.length ? X.cdInto([...p.metrics.map(m => m.cmd), ...(p.guard ? [p.guard] : [])], os.homedir()) : undefined;
			const there = into && fs.existsSync(into) ? await repoRoot(into) : undefined;
			const foreign = p.own_checkout ? await dirty(root) : "";
			if (there && there !== root) {
				await relocate(ctx, root, g, there, "its metric commands run there", true);
				root = there;
			} else if (foreign) {
				const own = await ownCheckout(root, L.rootOf(load(root), g).id);
				const n = foreign.split("\n").length;
				await relocate(
					ctx,
					root,
					g,
					own,
					`${root} has ${n} uncommitted change${n > 1 ? "s" : ""} that are not this goal's; they stay there untouched. Dependencies and env files are linked in; a virtualenv or build output is rebuilt there`,
					true,
				);
				root = own;
			}
			g = pick(load(root), g.id);
			const st0 = load(root);
			if (L.umbrella(st0, g)) throw new Error(`${g.id} is split into parts (${L.openParts(st0, g).map(c => c.id).join(", ")}): give each part its own scorecard (goal: <part>).`);
			if (!p.metrics?.length || p.metrics.length > X.MAX_METRICS)
				throw new Error(`Use 1-${X.MAX_METRICS} metrics: focus on the few that matter and list the rest under parked.`);
			const names = new Set<string>();
			for (const m of p.metrics) {
				if (!/^[a-z][a-z0-9_]*$/.test(m.name) || names.has(m.name)) throw new Error(`Metric names must be unique snake_case: "${m.name}".`);
				if (!m.hold && typeof m.target !== "number") throw new Error(`${m.name} needs a target, or hold: true if it is a constraint like "no slower".`);
				names.add(m.name);
			}
			// The review is asked about the whole goal: what the held card met must still be on the card, and still met.
			// Every target met but not closed (a re-measurement missed, or a hold looked regressed): the same checks confirm it.
			const confirming = !!g.reviewed || (X.reached(g) && !L.parts(st0, g).length);
			const prior = confirming && g.card && !L.parts(st0, g).length ? g.card : undefined;
			// Only a review hold pins the old metrics (the review is asked about the whole goal); a goal that
			// only awaits confirmation may change its checks, and those it keeps must still be met.
			const kept = (o: L.Metric) => p.metrics!.some(m => m.name === o.name && m.cmd === o.cmd);
			const held = prior && { ...prior, metrics: prior.metrics.filter(kept) };
			const dropped = g.reviewed ? (prior?.metrics.filter(o => !kept(o)) ?? []) : [];
			if (dropped.length)
				throw new Error(`Keep ${dropped.map(m => m.name).join(", ")} on the scorecard (same command; hold: true is fine): the acceptance review is asked about the whole goal, so what was met must be shown still met at HEAD.`);
			if (p.metrics.every(m => m.hold))
				throw new Error(
					g.reviewed
						? `Hold metrics only guard against regressions, so they cannot show what the acceptance review asked for (${g.reviewed.next}). Give that check a target (e.g. failures, down, target 0): one that already passes is welcome here, and when every metric meets its target the review is asked again.`
						: "At least one metric must have a target to climb; hold metrics only guard.",
				);
			const d = await dirty(root);
			if (d)
				throw new Error(
					`Working tree is dirty; commit or stash first so baselines are measured on a commit:\n${d}\nIf these changes are not this goal's (another session's or the user's work), leave them and call climb_scorecard again with own_checkout: true. climb then gives the goal its own checkout beside this one and this session follows it there, with no restart.`,
				);
			const metrics: L.Metric[] = p.metrics.map(m => ({
				name: m.name,
				cmd: m.cmd,
				dir: m.dir,
				target: m.target ?? Number.NaN,
				unit: m.unit,
				hold: m.hold || undefined,
				noise: pos(m.noise, 0.01),
				samples: Math.min(9, Math.round(pos(m.samples, 1))),
				timeout_s: pos(m.timeout_s, 600),
				// Strict-schema providers send 0 for "not given"; true (older callers) is 2.
				parallel: m.parallel === true ? 2 : typeof m.parallel === "number" && m.parallel > 1 ? Math.min(8, Math.floor(m.parallel)) : undefined,
				baseline: Number.NaN,
			}));
			const commands = [...metrics.map(m => m.cmd), p.guard ?? ""];
			const untracked = new Set((await git(root, "ls-files", "--others", "--exclude-standard")).stdout.split("\n").filter(Boolean));
			const loose = commands.flatMap(c => X.instrumentFiles(c, untracked));
			if (loose.length)
				throw new Error(`Commit the instrument first: ${[...new Set(loose)].join(", ")} is untracked, so the first revert would delete it and break every later measurement.`);
			const gerr = await guard(root, p.guard, g.id, signal);
			if (gerr)
				throw new Error(
					`The guard must pass at HEAD before climbing: ${gerr}\nIf that failure is what this goal sets out to fix, it belongs in a metric (e.g. a count of failing cases, target 0) or in an experiment's proof, not in the guard: the guard only protects what already works.`,
				);
			// A/A: at least 3 runs on one commit expose the metric's own noise, so the
			// keep/drop bar is measured, not guessed.
			const say = progressTo(ctx, root, onUpdate, "scorecard A/A");
			const fix = (errors: string[]) => new Error(`Fix these metric commands (exit 0 and print a number):\n${errors.join("\n")}\nGood runs on this commit are cached for 30 minutes; a retry only measures what is missing.`);
			// One run of each first: a broken command fails in one run, not after everything else's A/A.
			const smoke = await measureTree(root, metrics, () => 1, { phase: "smoke", goal: g.id }, signal, say);
			if (smoke.errors.length) throw fix(smoke.errors);
			const warnings: string[] = [];
			const pct = (x: number) => `±${(x * 100).toFixed(1)}%`;
			// What a measurement costs (from traced runs), so advice about samples comes with its price.
			const price = (m: L.Metric, samples: number) => {
				const one = T.runMs(T.read(root), g.id, m.name);
				return one === undefined ? "" : `~${T.dur(one * samples)} a measurement`;
			};
			const floor = Object.fromEntries(metrics.map(m => [m.name, m.noise]));
			// Baseline and noise from a metric's A/A runs; a problem refuses the scorecard.
			const assess = (m: L.Metric, xs: number[]): { problem?: string; warning?: string } => {
				m.baseline = X.median(xs);
				m.noise = Math.max(floor[m.name], X.noiseOf(xs, m.baseline, m.samples));
				const aa = `A/A runs ${xs.map(x => +x.toPrecision(4)).join(", ")}`;
				if (m.hold) {
					m.target = m.baseline;
					return m.noise > 0.5 ? { warning: `${m.name} only catches regressions beyond ${pct(m.noise)} (${aa}).` } : {};
				}
				// Once the acceptance review held the goal open, a check that already passes is what it asked for.
				if (L.met(m, m.baseline))
					return confirming ? {} : { problem: `${m.name} already meets its target (${m.baseline}, ${m.dir} ${m.target}): set an ambitious target, or hold: true if it is a constraint to keep.` };
				// The bar every kept step must clear, against the whole way to the target.
				const way = L.gain(m, m.baseline, m.target);
				const s = X.samplesFor(xs, m.baseline, way / 3) ?? X.samplesFor(xs, m.baseline, way);
				const cost = s ? price(m, s) : "";
				// The worst value repeating exactly while the rest vary looks like a cap, or a penalty for a failed case:
				// medians of more runs only mix the two populations.
				const worst = m.dir === "down" ? Math.max(...xs) : Math.min(...xs);
				const capped = xs.filter(x => x === worst).length >= 2 && xs.some(x => Math.abs(x - worst) > Math.abs(worst) * 0.3);
				// A small count (a few failures per run) is coarse: medians of more runs barely help, more cases per run do.
				const smallCount = xs.every(x => Number.isInteger(x) && x >= 0) && m.baseline <= 10;
				const fix = capped
					? `${worst} repeats exactly as the worst value: if it is a cap or a penalty for a failed case, more samples will not steady it. Count those failures in a metric of their own (target 0) and measure the rest without the penalty.`
					: smallCount
						? `A count this small is coarse: count over more cases per run (repeat the scenario inside the command and print the total), or make it a hold metric (it then guards against more failures) and put the target on a finer metric; an experiment's proof can show zero failures.`
						: `${s && s > m.samples ? `Samples: ${s} brings it to ${pct(X.noiseOf(xs, m.baseline, s))}${cost ? ` (${cost})` : ""}` : "More samples will not fix it"}; measure more cases per run (a median over 27 calls is steadier than over 9), or steady the command (fixed inputs, warm-up, no sentinel penalties).`;
				// A goal confirming a target it met before re-baselines a near miss (it climbs on), it is not refused.
				const again = confirming && prior?.metrics.some(o => o.name === m.name && o.cmd === m.cmd && o.target === m.target);
				if (m.noise >= way && !again)
					return { problem: `${m.name}: noise ${pct(m.noise)} (${aa}) is as large as the whole way to the target (${pct(way)}), so no result could be told apart from luck. ${fix}` };
				if (m.noise > way / 3) return { warning: `${m.name}: each kept step must beat ${pct(m.noise)}, ${Math.round((m.noise / way) * 100)}% of the way to target (${aa}). ${fix}` };
				// Every run on one value far from the target looks like a pinned cap or failure penalty: nothing under it
				// can show until every case passes, so no speed-up is ever kept.
				const pinned = xs.length >= 3 && xs.every(x => x === xs[0]) && m.target > 0 && xs[0] > 0 && (m.dir === "down" ? xs[0] >= 10 * m.target : m.target >= 10 * xs[0]);
				if (pinned)
					return {
						warning: `${m.name} read exactly ${xs[0]} on every A/A run, ${m.dir === "down" ? `${Math.round(xs[0] / m.target)}× its target` : `1/${Math.round(m.target / xs[0])} of its target`}. If that is a cap or a penalty for a failed case, no improvement under it can show until every case passes: count those failures in a metric of their own (target 0) and measure this over the cases that pass.`,
					};
				return {};
			};
			const cached = "Runs on this commit are cached for 30 minutes, so a retry only measures what changed.";
			// The A/A stops at the first metric that cannot pass; its finished runs stay cached.
			const { samples, errors, reused, stopped } = await measureTree(root, metrics, m => Math.max(3, m.samples), { phase: "aa", goal: g.id }, signal, say, (m, xs) => assess(m, xs).problem);
			if (errors.length) throw fix(errors);
			if (stopped) throw new Error(`${stopped}\n${cached}`);
			const problems: string[] = [];
			for (const m of metrics) {
				const a = assess(m, samples[m.name]);
				if (a.problem) problems.push(a.problem);
				if (a.warning) warnings.push(a.warning);
			}
			if (problems.length) throw new Error(`${problems.join("\n")}\n${cached}`);
			const outside = [...new Set(commands.flatMap(X.absolutePaths))].filter(f => !SYSTEM.test(f) && !f.startsWith(`${root}/`) && fs.existsSync(f));
			if (outside.length) {
				// A temp dir (a session scratchpad, /tmp) is wiped on reboot or by cleanup: then every measurement breaks at once.
				const temp = outside.filter(f => f.startsWith(os.tmpdir()) || /^\/(private\/)?(tmp|var\/folders)\//.test(f));
				warnings.push(
					`Instrument outside the repo, so climb cannot freeze or version it: ${outside.join(", ")}. A change there moves the metric invisibly.${temp.length ? ` ${temp.length === outside.length ? (temp.length > 1 ? "They are" : "It is") : `${temp.join(", ")} ${temp.length > 1 ? "are" : "is"}`} in a temp directory, cleared on reboot or cleanup: every measurement breaks then. Move ${temp.length > 1 ? "them" : "it"} into the repo or a stable path.` : ""}`,
				);
			}
			if (reused.length) warnings.push(`Reused A/A runs of this commit for ${reused.join(", ")}.`);
			// A slow metric run one at a time makes every experiment long: voice's proactivity judge took 5.5 min a run, so
			// a close call's 6 pairs took an hour. Say what running it in parallel would save, while the card is being set.
			for (const m of metrics) {
				const one = T.runMs(T.read(root), g.id, m.name);
				if (one === undefined || one < 120_000 || X.slots(m) > 1) continue;
				warnings.push(
					`${m.name} takes ~${T.dur(one)} a run, one at a time: a close call's ${X.PAIRS} pairs take ~${T.dur(one * 2 * X.PAIRS)}. If its runs can go at once (each takes its port from $CLIMB_SLOT), parallel: 2 halves that; if it makes many calls in a row inside one run, running those concurrently shortens every run.`,
				);
			}
			const tracked = new Set((await git(root, "ls-files")).stdout.split("\n").filter(Boolean));
			// An explicit list is authoritative (pass [] to freeze nothing); otherwise freeze what the commands execute.
			const frozen = p.frozen ?? [...new Set(commands.flatMap(c => X.instrumentFiles(c, tracked)))];
			// The instrument's identity: its commands and the frozen files' contents at this commit.
			const blobs = (await git(root, "ls-files", "-s")).stdout.split("\n").filter(Boolean).map(l => ({ blob: l.split(" ")[1], file: l.split("\t")[1] }));
			const frozenNow = new Set(X.touchedFrozen(blobs.map(b => b.file), frozen));
			const instrument = sha([...commands, ...blobs.filter(b => frozenNow.has(b.file)).map(b => `${b.file} ${b.blob}`)].join("\n")).slice(0, 16);
			const h = await head(root);
			// Verifications the review asked for, all passing (and the held card's metrics still at their old targets):
			// the A/A runs are the confirmation, and the review decides again.
			const baselines = Object.fromEntries(metrics.map(m => [m.name, m.baseline]));
			const allMet = metrics.every(m => L.met(m, m.baseline));
			// Everything on the card met, but a metric met before has slipped since: nothing here could climb it back.
			// A hold is judged in pairs against its old card's commit, never raw against a baseline the machine drifted from.
			const slipped = held?.metrics.filter(o => !o.hold && !L.met(o, baselines[o.name])) ?? [];
			const slidHolds = held && allMet ? await holdsSlid(root, held, baselines, g.id, signal, say) : undefined;
			if (allMet && (slipped.length || slidHolds))
				throw new Error(
					`${[...slipped.map(o => `${o.name} is ${baselines[o.name]} at HEAD, short of its target ${o.target}`), ...(slidHolds ? [slidHolds] : [])].join("; ")}: a commit since it was met undid it. Put it on the scorecard with its target to climb it back, or restore it first.\n${cached}`,
				);
			const reask = confirming && allMet;
			append(root, { ts: L.now(), kind: "card", goal: g.id, metrics, guard: p.guard, frozen, head: h, parked: p.parked, axioms: p.axioms, instrument, env: ENV, reask: reask || undefined });
			let verdict = "Next: call climb_experiment with your highest-expected-gain lever.";
			if (reask) {
				say("acceptance review: every metric meets its target here; is the intent met?");
				const { unmet, closedUp } = await accept(ctx, root, g, baselines);
				await writeExport(root);
				const st = refresh(ctx, root);
				verdict = unmet ? unmetText(unmet) : achievedText(st, ctx, st.goals.get(g.id) ?? g, closedUp);
			} else refresh(ctx, root);
			const lines = metrics.map(
				m =>
					`- ${m.name} = ${m.baseline}${m.unit ? ` ${m.unit}` : ""} → ${m.hold ? "hold (must not regress)" : `target ${m.target}`} (${m.dir} is better, noise ${pct(m.noise)}, ${m.samples} run${m.samples > 1 ? "s" : ""} per measurement${price(m, m.samples) ? `, ${price(m, m.samples)}` : ""})`,
			);
			return ok(
				[
					`Scorecard set for ${g.id}; baselines measured by the extension:`,
					...lines,
					`Frozen instrument: ${frozen.join(", ") || "none — declare frozen paths so experiments cannot game the measurement"}`,
					...warnings,
					verdict,
				].join("\n"),
			);
		})),
	});

	pi.registerTool({
		name: "climb_probe",
		label: "Climb: probe",
		description:
			"Research item: register one candidate metric. The extension runs the command once and records the number, so research is itemized, measured, and counted as progress before a scorecard exists. Probe several candidates, then pick the 1-3 that matter for climb_scorecard.",
		parameters: S.obj({
			goal: S.opt(S.str("Goal id; optional when one goal is active")),
			name: S.str("snake_case candidate metric name"),
			cmd: S.str("Shell command printing the value as its last number"),
			note: S.opt(S.str("Why it might matter, direction, what it measures")),
			timeout_s: S.opt(S.num("Timeout in seconds; default 120, max 1800")),
		}),
		loadMode: "essential",
		execute: logged("climb_probe", (_id, p: ProbeParams, signal, _u, ctx) =>
			exclusive(async () => {
				worker(ctx);
				const root = await needRoot(ctx);
				holder(root, ctx);
				const g = pick(load(root), p.goal);
				if (!/^[a-z][a-z0-9_]*$/.test(p.name)) throw new Error(`Probe names must be snake_case: "${p.name}".`);
				// Research may run on an uncommitted tree, so nothing is restored afterwards.
				const limit = Math.min(1800, Math.round(pos(p.timeout_s, 120)));
				const r = await run(root, p.cmd, limit * 1000, { phase: "probe", goal: g.id }, signal);
				if (signal?.aborted) throw new Error("Probe interrupted; nothing recorded.");
				const n = r.code === 0 ? X.parseNumber(r.stdout) : undefined;
				const error =
					r.code !== 0
						? r.killed
							? `timed out after ${limit}s (pass timeout_s for a slow command)`
							: `exit ${r.code}: ${said(r)}`
						: n === undefined
							? `no number in output: ${tail(r.stdout) || "(empty)"}`
							: undefined;
				append(root, { ts: L.now(), kind: "probe", goal: g.id, name: p.name, cmd: p.cmd, value: n, error, note: p.note });
				refresh(ctx, root);
				const count = load(root).goals.get(g.id)!.probes.filter(x => x.value !== undefined).length;
				return ok(error ? `Probe ${p.name} failed: ${error}` : `Probe ${p.name} = ${n} (research item ${count}).`);
			})),
	});

	pi.registerTool({
		name: "climb_experiment",
		label: "Climb: experiment",
		description:
			"Pre-register one experiment before touching code: the lever (kind of change, reused across attempts), hypothesis, and predicted metric movement. The extension measures the control on the current clean commit. Then implement, commit, and call climb_measure. One experiment at a time: one working tree measures one change. Scorecard metrics decide; for a defect fix they are too coarse to see, add a proof." + DIRECT,
		parameters: S.obj({
			goal: S.opt(S.str("Goal id; optional when one goal is active")),
			lever: S.str("Short lever name, e.g. 'caching' or 'sieve algorithm'"),
			hypothesis: S.str("Why this should move the metric"),
			prediction: S.str("Expected movement, e.g. 'runtime_ms -60%'"),
			proof: S.opt(
				S.str(
					"Optional deterministic check (seconds ideally; at most 10 minutes) that fails now and passes (exit 0) once the change works: a regression test or a replay of the defect, e.g. 'bun test test/handoff.test.ts' or 'test \"$(bun bench/replay.ts)\" -eq 0'. Write it before registering; it must fail here and its scripts must stay unchanged. With it passing and no metric regressed, the experiment is kept even if nothing moved beyond noise. A measured gain is kept even while the proof still fails (partial progress), and the result says the claimed fix is not complete.",
				),
			),
		}),
		loadMode: "essential",
		execute: logged("climb_experiment", (_id, p: ExperimentParams, signal, onUpdate, ctx) => exclusive(async () => {
			worker(ctx);
			const root = await needRoot(ctx);
			holder(root, ctx);
			const st = load(root);
			const g = pick(st, p.goal);
			if (L.umbrella(st, g)) throw new Error(`${g.id} is split into parts; experiment on one of them (goal: ${L.openParts(st, g).map(c => c.id).join(" | ")}).`);
			if (!g.card) throw new Error(`Define the scorecard first with climb_scorecard${g.parent ? ` (goal: "${g.id}")` : ""}.`);
			const busy = L.active(st).find(x => x.open);
			if (busy?.open) throw new Error(`Experiment ${busy.open.id} on ${busy.id} is still open; finish it with climb_measure first.`);
			// A stall belongs to the whole tree: no part experiments until the judge has spoken.
			const top = L.rootOf(st, g);
			if (top.stallPending) {
				if (!hasJudge(ctx)) throw new Error(X.nextAction(st, top));
				// A stall whose judge never ran (or died with a restart) gets one now.
				if (!judging.has(top.id)) void judge(ctx, root, top.id, "stall left without a verdict");
				throw new Error("The independent judge is reviewing this stall; its verdict arrives as a message shortly. Record your own diagnosis with climb_judge meanwhile if you have one.");
			}
			const blocked = X.streakBlocked(g);
			if (blocked) {
				if (!hasJudge(ctx)) throw new Error(`${blocked} No independent judge on this host: call climb_judge with an honest diagnosis of why they failed and what is fundamentally different next.`);
				void judge(ctx, root, g.id, "drop streak");
				throw new Error(`${blocked} The independent judge is reviewing; its verdict arrives as a message. Meanwhile work out what is fundamentally different about the next move.`);
			}
			const d = await dirty(root);
			if (d)
				throw new Error(
					`Working tree has uncommitted changes; an experiment starts from the measured commit. If they are this experiment: git stash, call climb_experiment, git stash pop, commit, climb_measure.\n${d}`,
				);
			const moved = await instrumentChanged(root, g.card, g.card.head);
			if (moved.length) throw new Error(`The instrument changed since the scorecard (${moved.join(", ")}); re-baseline with climb_scorecard first.`);
			const base = await head(root);
			if (!base) throw new Error("The repository has no commits yet.");
			// Evidence that is not on the scorecard cannot decide; say so before an expensive control.
			const onCard = new Set(g.card.metrics.map(m => m.name));
			const offCard = [...new Set(g.probes.map(x => x.name))].filter(n => !onCard.has(n) && new RegExp(`\\b${n}\\b`).test(p.prediction));
			if (offCard.length && !p.proof)
				throw new Error(
					`The prediction rests on ${offCard.join(", ")}, a probe, not a scorecard metric: it cannot decide this experiment, and a real fix would be reverted if the scorecard does not move beyond noise. Pass proof (a check that fails now and passes once fixed, e.g. the probe as 'test "$(<probe cmd>)" -eq 1'), or predict scorecard movement only.`,
				);
			// Pairs noisier than the whole way to the target cannot keep any step: without a proof, measuring is hours of coin toss.
			const targeted = g.card.metrics.filter(m => !m.hold);
			const blind = p.proof ? [] : deaf(root, g);
			if (targeted.length && blind.length === targeted.length)
				throw new Error(
					`No measurement can keep this experiment: ${blind.map(b => `${b.m.name}'s pairs are spread so widely that even ${b.n} pairs would read ±${(b.noise * 100).toFixed(1)}%, more than the whole way to its target (${(b.way * 100).toFixed(1)}%)`).join("; ")}. Any result would be luck. ${STEADY} Or pass proof: a verified fix is kept when nothing regressed.`,
				);
			const say = progressTo(ctx, root, onUpdate, `${g.id} x${g.nextExp} control`);
			let proof: L.Proof | undefined;
			let ignoredProof: string[] = [];
			if (p.proof) {
				// Paths after `cd` are relative to somewhere else: not checked here.
				const missing = /(^|[;&|(]\s*)cd\s/.test(p.proof) ? [] : X.scriptPaths(p.proof).filter(f => !fs.existsSync(path.join(root, f)));
				if (missing.length) throw new Error(`The proof runs ${missing.join(", ")}, which does not exist yet. Write the failing check first, then register.`);
				say("proof must fail at base");
				const pr = await proofRuns(root, p.proof, g.id, signal);
				if (pr.broken) throw new Error(`The proof ${pr.broken}: a proof must be a check that runs here and fails for the defect's reason.`);
				if (pr.passed) throw new Error(`The proof passed ${pr.passed}/2 runs at ${base.slice(0, 8)}: it must fail before the change, or it proves nothing.`);
				const files = new Set([...(await git(root, "ls-files", "--cached", "--others", "--exclude-standard")).stdout.split("\n").filter(Boolean)]);
				const scripts = [...new Set([...X.instrumentFiles(p.proof, files).filter(f => !f.endsWith("/")), ...X.scriptPaths(p.proof)])];
				// A runner that finds its own tests (bun test -t x, npm run check, pytest -k x) freezes nothing:
				// the worker could edit the check until it passes.
				if (!scripts.length && X.indirectRunner(p.proof))
					throw new Error("Name the check's file in the proof (e.g. 'bun test test/x.test.ts' or 'pytest tests/t.py::case') so it can be frozen; a runner that discovers its own tests freezes nothing.");
				proof = { cmd: p.proof, files: await hashes(root, scripts), ms: pr.ms };
				// A git-ignored check is neither versioned nor restorable: if it disappears, the proof is void.
				if (scripts.length) ignoredProof = (await git(root, "check-ignore", ...scripts)).stdout.split("\n").filter(Boolean);
			}
			// Commits made outside an experiment (a .gitignore, a failed revert) are adopted
			// only if they pass the guard and regress nothing against the last measured baseline:
			// they must never quietly lower the bar. The guard runs first: it is the cheap refusal.
			let unmeasured: string | undefined;
			let harmless = false;
			if (g.baseRef) {
				const [want, have] = await Promise.all([tree(root, g.baseRef), tree(root)]);
				if (want && want !== have) {
					unmeasured = g.baseRef.slice(0, 8);
					// A committed failing test that is this experiment's proof is meant to break the guard.
					const changed = (await git(root, "diff", "--name-only", `${g.baseRef}..HEAD`)).stdout.split("\n").filter(Boolean);
					const onlyProof = !!proof && changed.length > 0 && changed.every(f => f in proof!.files);
					// Tests, docs and the proof's own scripts cannot move a metric that does not run them.
					const frozen = new Set(X.touchedFrozen(changed, g.card.frozen));
					const commands = g.card.metrics.map(m => m.cmd);
					harmless = changed.length > 0 && changed.every(f => !frozen.has(f) && ((proof && f in proof.files) || X.inert(f, commands)));
					const gerr = onlyProof ? undefined : await guard(root, g.card.guard, g.id, signal);
					if (gerr)
						throw new Error(
							`Commits since the last measured baseline ${unmeasured} break the guard: ${gerr}. Fix or revert them before experimenting${proof ? "" : "; if a failing test there is this experiment's check, pass it as proof"}.`,
						);
				}
			}
			// A metric whose history drifts is decided in pairs, which measure the base afresh beside the candidate:
			// a control measured now is stale by then (voice re-ran a 5-minute call bench 3 times per experiment
			// for one). Its reference is the median of every run of this tree; one that shares its command with a
			// steady metric costs nothing to measure, and commits made outside experiments still measure everything.
			const traces0 = T.read(root);
			const eff0 = effective(root, g, traces0).metrics;
			const baseTree0 = await tree(root);
			const since0 = cardSince(root, g);
			const drifts = g.card.metrics.filter((m, i) => eff0[i].noise > m.noise);
			const known = (m: L.Metric) => (baseTree0 ? T.treeMedian(traces0, g.id, m.name, baseTree0, since0, cmdId(m.cmd)) : undefined);
			const inPairs = unmeasured ? [] : drifts.filter(m => known(m) !== undefined && !g.card!.metrics.some(o => o.cmd === m.cmd && !drifts.includes(o)));
			const control = await measureTree(root, g.card.metrics.filter(m => !inPairs.includes(m)), m => m.samples, { phase: "control", goal: g.id }, signal, say);
			if (control.errors.length) throw new Error(`Control measurement failed at ${base.slice(0, 8)}:\n${control.errors.join("\n")}`);
			for (const m of inPairs) control.values[m.name] = known(m)!;
			let adopted = "";
			if (unmeasured && harmless) adopted = ` Adopted commits since ${unmeasured}: only test sources or the proof changed.`;
			else if (unmeasured) {
				// Judge against everything measured on the baseline tree, not one window of it, and with a
				// higher bar: this is a sanity check on commits outside experiments, and drift is not a regression.
				const traces = T.read(root);
				const baseTree = (await tree(root, g.baseRef!)) ?? "";
				const since = cardSince(root, g);
				const reference = Object.fromEntries(g.card.metrics.map(m => [m.name, T.treeMedian(traces, g.id, m.name, baseTree, since, cmdId(m.cmd)) ?? g.baseValues?.[m.name]])) as L.Values;
				const lenient = effective(root, g, traces).metrics.map(m => ({ ...m, noise: 2 * m.noise }));
				let worse = X.regressions(lenient, reference, control.values);
				// Before refusing, measure the baseline and HEAD interleaved: drift between then and now cancels.
				let checked = "";
				if (worse.length) {
					const pairs = await paired(root, g.baseRef!, worse, g.id, signal, t => say(t && `paired check of the commits since ${unmeasured}: ${t}`));
					if (typeof pairs === "string") checked = ` The paired check could not finish (${pairs}).`;
					else if (pairs) {
						const pv = X.pairedVerdict(worse, pairs);
						worse = worse.filter(m => pv.stats[m.name] && pv.stats[m.name].gain < -pv.stats[m.name].noise);
						checked = ` A paired check (base and HEAD interleaved) found ${worse.length ? "a real regression" : "drift, not a regression"}: ${pv.reason.replace(/^[^:]*: /, "")}.`;
					}
				}
				if (worse.length)
					throw new Error(`${checked ? `${checked.trim()} ` : ""}` +
						`Commits since the last measured baseline ${unmeasured} regressed ${worse.map(m => `${m.name} ${+reference[m.name].toPrecision(6)}→${+control.values[m.name].toPrecision(6)} (beyond twice its ±${(m.noise * 50).toFixed(1)}% noise)`).join(", ")}. Revert them (git revert) or register them as an experiment; unmeasured regressions cannot lower the bar. If another part's kept change caused it, that is a trade-off between parts: re-baseline this part with climb_scorecard to accept it.`,
					);
				adopted = ` Adopted commits since ${unmeasured}: guard passes, no regression.${checked}`;
			}
			const id = `x${g.nextExp}`;
			append(root, { ts: L.now(), kind: "exp", goal: g.id, id, lever: p.lever, hypothesis: p.hypothesis, prediction: p.prediction, base, ref: control.values, proof, runs: control.samples, env: ENV.hash });
			refresh(ctx, root);
			const ref = Object.entries(control.values).map(([k, v]) => `${k}=${v}`).join(", ");
			const reused =
				(control.reused.length ? ` (${control.reused.join(", ")}: reused runs of this tree from the last 30 minutes)` : "") +
				(inPairs.length ? ` (${inPairs.map(m => m.name).join(", ")}: the median of this tree's earlier runs; it drifts, so climb_measure decides it in pairs with the base measured afresh)` : "");
			const proved = proof
				? ` The proof fails here, as it must; its scripts (${Object.keys(proof.files).join(", ") || "inline"}) are frozen for ${id}.${ignoredProof.length ? ` Warning: ${ignoredProof.join(", ")} is git-ignored, so nothing versions or restores it; if it is deleted or cleaned up, the proof is void. Keep checks in tracked paths.` : ""}`
				: "";
			return ok(
				`Registered ${id} on ${g.id}.${adopted} Control at ${base.slice(0, 8)}: ${ref}${reused}.${proved} Implement it and commit (any number of commits), then call climb_measure. Everything after ${base.slice(0, 8)} is this experiment; if it is dropped the extension reverts it.`,
			);
		})),
	});

	pi.registerTool({
		name: "climb_measure",
		label: "Climb: measure",
		description:
			"Close the open experiment: the extension runs the guard and every metric on the committed HEAD, compares against the pre-registered control, and decides kept or dropped (noise-aware). Dropped experiments are reverted with a revert commit. Requires a clean tree and at least one commit since registration. A measurement that crashes decides nothing: the experiment stays open. abandon drops and reverts it without measuring." + DIRECT,
		parameters: S.obj({
			goal: S.opt(S.str("Goal id; optional")),
			abandon: S.opt(S.str("Drop and revert the open experiment without measuring, giving the reason (e.g. its instrument is broken)")),
		}),
		loadMode: "essential",
		execute: logged("climb_measure", (_id, p: MeasureParams, signal, onUpdate, ctx) => exclusive(async () => {
			worker(ctx);
			const root = await needRoot(ctx);
			holder(root, ctx);
			const g = pick(load(root), p.goal, x => !!x.open);
			const exp = g.open;
			if (!exp || !g.card) throw new Error(`No open experiment on ${g.id}; register one with climb_experiment.`);
			const d = await dirty(root);
			if (d) throw new Error(`Commit your change first; climb measures commits, never a dirty tree:\n${d}`);
			// Strict-schema providers fill every optional field: "" is not a reason, so not an abandon.
			if (typeof p.abandon === "string" && p.abandon.trim()) {
				const at = (await head(root)) ?? exp.base;
				let reason = `abandoned: ${p.abandon || "no reason given"}`;
				let reverted: string | undefined;
				if (at !== exp.base) {
					const rv = await revert(root, exp, reason);
					if (rv.sha) reverted = rv.sha;
					else reason += ` — auto-revert failed (${rv.err}); restore by hand: git revert --no-commit ${exp.base.slice(0, 8)}..HEAD && git commit`;
				}
				append(root, { ts: L.now(), kind: "result", goal: g.id, exp: exp.id, head: at, values: {}, verdict: "dropped", reason, reverted, env: ENV.hash });
				await writeExport(root);
				const st = refresh(ctx, root);
				return ok(`DROPPED ${exp.id} (${reason}).${reverted ? ` Reverted in ${reverted.slice(0, 8)}.` : ""}\n${X.nextAction(st, L.rootOf(st, st.goals.get(g.id)!))}`);
			}
			const h = await head(root);
			if (!h || h === exp.base) throw new Error(`HEAD is still the base commit ${exp.base.slice(0, 8)}; commit ${exp.id} first.`);
			const say = progressTo(ctx, root, onUpdate, `${g.id} ${exp.id}`);
			const free0 = disk.free(root);
			let values: L.Values = {};
			let samples: Record<string, number[]> = {};
			let kept = false;
			let byProof = false;
			let streakChecked: string | undefined;
			say("guard");
			const broken = await guard(root, g.card.guard, g.id, signal);
			const moved = await instrumentChanged(root, g.card, exp.base);
			// A candidate that fails the guard is broken, not evidence against its idea: like a
			// crashed metric it decides nothing, and the work stays for the fix.
			if (broken && !moved.length)
				throw new Error(
					`${exp.id} was not measured: ${broken}\nNothing was decided and ${exp.id} stays open: fix it in another commit and call climb_measure again, or climb_measure with abandon if the idea itself is broken.`,
				);
			const gates: L.Gates = { guard: !g.card.guard ? "none" : broken ? "fail" : "pass", instrument: moved.length ? "changed" : "same" };
			let reason = moved.length ? `instrument changed (${moved.join(", ")}): the measurement is not comparable` : undefined;
			let noted = "";
			let pairs: Record<string, [number, number][]> | undefined;
			if (!reason) {
				const candidate = await tree(root);
				const history = T.read(root);
				const eff = effective(root, g, history);
				const opened = L.epoch(exp.ts);
				// Runs this experiment already finished on this tree count: a measurement that was cut off resumes
				// where it stopped, and calling again cannot re-roll them.
				const resumed = (phase: T.Phase, ms: L.Metric[], prior: Record<string, number[]> = {}) => {
					const done = ms.map(m => (candidate ? T.runsOf(history, g.id, m.name, phase, candidate, opened, cmdId(m.cmd)).slice(0, m.samples) : []));
					ms.forEach((m, i) => done[i].length && T.append(root, { ts: L.now(), kind: "reuse", phase, goal: g.id, metric: m.name, runs: done[i].length }));
					return { plan: ms.map((m, i) => ({ ...m, samples: m.samples - done[i].length })), prior: Object.fromEntries(ms.map((m, i) => [m.name, [...(prior[m.name] ?? []), ...done[i]]])) };
				};
				const plain = (phase: T.Phase, ms: L.Metric[], prior?: Record<string, number[]>, progress: Progress = say) => {
					const x = resumed(phase, ms, prior);
					return measure(root, x.plan, { phase, goal: g.id, tree: candidate }, signal, x.prior, progress);
				};
				// A metric whose history shows drift is decided in pairs whatever its plain runs say: it skips them.
				const drifting = g.card.metrics.filter((m, i) => eff.metrics[i].noise > m.noise);
				let r = await plain("result", g.card.metrics.filter(m => !drifting.includes(m)));
				// Borderline, or a metric whose history shows drift: the control was measured at another
				// time, so measure base and candidate interleaved and let drift cancel. If the base cannot
				// be checked out, fall back to measuring the candidate again.
				// Only the uncertain metrics pay for pairs: borderline here, or drifting in their history.
				const uncertain = r.errors.length ? [] : g.card.metrics.filter((m, i) => drifting.includes(m) || X.borderline([eff.metrics[i]], exp.ref, r.values));
				if (uncertain.length) {
					const p = await paired(root, exp.base, uncertain, g.id, signal, t => say(t && `paired with the base: ${t}`), opened);
					// These metrics need pairs to be told apart from luck: a paired run that crashes decides nothing.
					if (typeof p === "string")
						throw new Error(
							`Measurement failed in the paired check (base and candidate interleaved), even after retrying the run once; nothing was decided and ${exp.id} stays open:\n${p}\nFlaky: call climb_measure again. Broken by your change: fix it, commit, measure again.`,
						);
					pairs = p;
				}
				if (pairs)
					// A metric decided in pairs reads as its candidate side.
					for (const m of drifting) {
						r.samples[m.name] = pairs[m.name].map(p => p[1]);
						r.values[m.name] = X.median(r.samples[m.name]);
					}
				else if (uncertain.length) {
					// No pairs (the base cannot be checked out): the drifting metrics get their plain runs after all.
					if (drifting.length) {
						const x = resumed("result", drifting, r.samples);
						r = await measure(root, [...g.card.metrics.filter(m => !drifting.includes(m)).map(m => ({ ...m, samples: 0 })), ...x.plan], { phase: "result", goal: g.id, tree: candidate }, signal, { ...r.samples, ...x.prior }, say);
					}
					if (!r.errors.length && X.borderline(eff.metrics, exp.ref, r.values)) r = await plain("recheck", g.card.metrics, r.samples, t => say(t && `re-measure (borderline) ${t}`));
				}
				// A crashed instrument is not evidence against the change: decide nothing.
				if (r.errors.length)
					throw new Error(
						`Measurement failed, even after retrying each failed run once; nothing was decided and ${exp.id} stays open:\n${r.errors.join("\n")}\nFlaky: call climb_measure again. Broken by your change: fix it, commit, measure again. Instrument broken: climb_measure with abandon, repair it, re-baseline with climb_scorecard.`,
					);
				({ values, samples } = r);
				const pv = pairs && X.pairedVerdict(eff.metrics, pairs, { ref: exp.ref, values });
				const v = pv || X.verdict(eff.metrics, exp.ref, values);
				// Contention is the first suspect when a result moves: say when the two sides ran under different load.
				const traces = T.read(root);
				const since = L.epoch(exp.ts) - 3_600_000;
				const baseTree = (await tree(root, exp.base)) ?? "";
				const loadBefore = T.loadOf(traces, g.id, baseTree, ["control", "aa", "smoke"], since);
				const loadAfter = candidate ? T.loadOf(traces, g.id, candidate, ["result", "recheck"], since) : undefined;
				if (loadBefore !== undefined && loadAfter !== undefined && Math.max(loadBefore, loadAfter) > 1 && Math.max(loadBefore, loadAfter) > 2 * Math.min(loadBefore, loadAfter))
					noted += ` Note: the ${loadAfter > loadBefore ? "candidate" : "control"} ran under heavier load (${loadAfter} vs ${loadBefore} load average).`;
				if (eff.notes.length) noted += ` Note: ${eff.notes.join("; ")}.`;
				if (pv)
					for (const m of g.card.metrics) {
						const s = pv.stats[m.name];
						const way = L.gain(m, m.baseline, m.target);
						const most = s?.n ? X.pairNoiseAt(m, pairs![m.name] ?? []) : 0;
						if (!m.hold && s?.n && most >= way)
							noted += ` Note: ${m.name}'s pairs are spread so widely that even ${X.PAIRS} pairs would read ±${(most * 100).toFixed(1)}%, more than the whole way to its target (${(way * 100).toFixed(1)}%): no step on it can be told apart from luck, and experiments without a proof are refused until it is steadier. ${STEADY}`;
					}
				({ kept, reason } = v);
				// A real-sized step under the noise is evidence of neither: say how many samples would resolve it
				// (noise shrinks with the square root of the samples), or that the instrument needs steadying.
				if (!kept && !v.regressed && !pairs)
					for (const m of eff.metrics) {
						const step = m.hold ? 0 : L.gain(m, exp.ref[m.name], values[m.name]);
						if (!(step >= m.noise / 2 && step < m.noise)) continue;
						const need = Math.ceil(m.samples * (m.noise / step) ** 2 * 1.5);
						const one = T.runMs(traces, g.id, m.name);
						const size = `${m.name} moved +${(step * 100).toFixed(1)}%, under its ±${(m.noise * 100).toFixed(1)}% noise at ${m.samples} sample${m.samples > 1 ? "s" : ""}`;
						noted +=
							need <= 9
								? ` Note: ${size}: a step this size shows at samples ${need}${one ? ` (~${T.dur(one * need)} a measurement)` : ""}. If steps like this matter, re-score with climb_scorecard at that sample count.`
								: ` Note: ${size}: even 9 samples would not resolve a step this size; steady the instrument (fixed inputs, fewer moving parts) if steps like this matter.`;
					}
				// A registered proof is the experiment's own claim: it must hold for any keep, and
				// when nothing regressed it keeps a fix the scorecard is too coarse to see.
				if (!v.regressed && exp.proof) {
					const now = await hashes(root, Object.keys(exp.proof.files));
					const edited = Object.keys(exp.proof.files).filter(f => now[f] !== exp.proof!.files[f]);
					let failed = edited.length ? `proof void: ${edited.join(", ")} changed since registration` : "";
					gates.proof = edited.length ? "void" : "fail";
					if (!failed) {
						say("proof");
						const pr = await proofRuns(root, exp.proof.cmd, g.id, signal, proofLimit(exp.proof));
						// A check that cannot run is not evidence against the change: decide nothing.
						if (pr.broken) throw new Error(`The proof ${pr.broken}; nothing was decided and ${exp.id} stays open. Free the machine or fix the environment, then climb_measure again (or abandon).`);
						if (pr.passed < 2) failed = `proof still fails (${pr.passed}/2 runs passed): ${pr.out}`;
					}
					// A proof can only add a keep. A measured gain stands even when the claimed fix is not complete
					// yet (8 errors → 6 is a step toward 0); the result says so, and "achieved" still needs the
					// acceptance review, which sees the claim was not met.
					if (failed && kept) reason += `; but ${failed}: the claimed fix is not complete yet`;
					else if (failed) reason += `; ${failed}`;
					else if (kept) reason += "; proof passes";
					else {
						kept = byProof = true;
						reason = `proof passes (it failed at ${exp.base.slice(0, 8)}): ${exp.proof.cmd}; ${reason.replace(/^no metric beat noise/, "no metric regressed")}`;
					}
					if (!failed) gates.proof = "pass";
				}
				// Each proof keep asks only "no worse than the step before", so a slow slide passes every one (platinum's
				// preference against the client's pick went 61 → 37 over five keeps). From the STREAK-th keep in a row, a keep is
				// measured in pairs against where the streak started; a slide beyond noise stops it, a pass starts a new streak.
				const anchor = byProof ? X.streakAnchor(g) : undefined;
				if (anchor && anchor.n + 1 >= X.STREAK) {
					// A slide is a loss beyond the scorecard's own noise, the bar one step's regression faces. The check pairs
					// until it settles (clearly slid, or clearly not), up to SLIDE_PAIRS: a 6-pair check of a ±28% jury proved
					// nothing, and its "hold" let platinum's preference slide from 50 to ~38 over ten keeps.
					const held = g.card.metrics.map(m => ({ ...m, hold: true }));
					// Its pairs fit a time budget: voice's 4-minute judge, one run at a time, could take 20 pairs (2.7 h).
					const traced = T.read(root);
					const pairMs = Math.max(...held.map(m => (2 * (T.runMs(traced, g.id, m.name) ?? 0)) / Math.min(2, X.slots(m))));
					const cap = pairMs > 0 ? Math.max(X.STREAK, Math.min(SLIDE_PAIRS, Math.floor(SLIDE_BUDGET_MS / pairMs))) : SLIDE_PAIRS;
					const sp = await paired(root, anchor.head, held, g.id, signal, t => say(t && `the ${anchor.n + 1} proof keeps since ${anchor.head.slice(0, 8)}, in pairs: ${t}`), undefined, cap);
					if (typeof sp === "string") throw new Error(`The check of the streak of proof keeps against ${anchor.head.slice(0, 8)} failed; nothing was decided and ${exp.id} stays open:\n${sp}\nFlaky: call climb_measure again.`);
					if (sp) {
						const sv = X.pairedVerdict(held, sp);
						// Blind: its interval is wider than the slide it must see. A tight interval near the edge is a call, not blindness.
						const blind = held.filter(m => sp[m.name]?.length && sv.stats[m.name] && sv.stats[m.name].noise > m.noise);
						const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
						if (sv.regressed) {
							kept = byProof = false;
							reason += `; but the ${anchor.n + 1} proof keeps since ${anchor.head.slice(0, 8)} slid together: ${sv.reason.replace(/^regressed, /, "")}. Each passed against the step before; together they are worse. Drop this one, and undo or rethink the slide, or accept it by re-baselining with climb_scorecard`;
						} else if (blind.length) {
							kept = byProof = false;
							reason += `; but nothing can check the ${anchor.n + 1} proof keeps since ${anchor.head.slice(0, 8)}: ${blind.map(m => (sv.stats[m.name].modes ? `${m.name}'s ${sv.stats[m.name].n} pairs land in two clusters (${pct(sv.stats[m.name].modes![0])} and ${pct(sv.stats[m.name].modes![1])}), so its instrument reads one of two values` : `even ${sv.stats[m.name].n} pairs leave ${m.name} at ±${pct(sv.stats[m.name].noise)}, wider than the ±${pct(m.noise)} slide it must see`)).join("; ")}. A proof keeps a change only where a regression would show, and none would here. Steady the instrument (more judgments per run, sides shuffled) or take the open choices to the user`;
						} else {
							streakChecked = anchor.head;
							reason += `; the ${anchor.n + 1} proof keeps since ${anchor.head.slice(0, 8)} hold against it in pairs, to within ${held.map(m => `±${pct(m.noise)} ${m.name}`).join(", ")}`;
						}
					}
				}
			}
			if (noted) reason = `${reason!.replace(/[.\s]*$/, "")}.${noted}`;
			let reverted: string | undefined;
			if (!kept) {
				const rv = await revert(root, exp, reason!);
				if (rv.sha) reverted = rv.sha;
				else reason += ` — auto-revert failed (${rv.err}); restore by hand: git revert --no-commit ${exp.base.slice(0, 8)}..HEAD && git commit`;
			}
			append(root, { ts: L.now(), kind: "result", goal: g.id, exp: exp.id, head: h, values, verdict: kept ? "kept" : "dropped", reason: reason!, reverted, proof: byProof || undefined, runs: samples, paired: pairs, gates, env: ENV.hash, checked: (kept && streakChecked) || undefined });
			// A result kept on its proof was not chosen for its numbers: its runs are fair samples of the new base,
			// and the next experiment's control reuses them (voice re-measured 6-8 minutes of them per experiment).
			const keptTree = byProof ? await tree(root) : undefined;
			if (keptTree) for (const m of g.card.metrics) if (samples[m.name]?.length) runs.set(`${keptTree}\0${m.name}\0${m.cmd}`, { ts: L.clock.ms(), xs: samples[m.name] });
			// Targets close a goal; a hold only must not have regressed, and its raw value against an old
			// baseline is mostly the machine's drift, so one that looks regressed is checked in pairs.
			const targetsMet = (vals: L.Values) => g.card!.metrics.every(m => m.hold || L.met(m, vals[m.name]));
			let won = kept && targetsMet(values);
			let unmet: { unmet: string; next: string } | undefined;
			let closedUp: string[] = [];
			let slid: string | undefined;
			if (won) {
				// "Done" is never claimed from a single draw: confirm with fresh samples. The result above is
				// already recorded: a closing check that is interrupted leaves the goal open to confirm later.
				let c: Awaited<ReturnType<typeof measure>> | undefined;
				try {
					c = await measure(root, g.card.metrics, { phase: "confirm", goal: g.id }, signal, samples, t => say(t && `confirming targets ${t}`));
					won = !c.errors.length && targetsMet(c.values);
					if (won) slid = await holdsSlid(root, g.card, c.values, g.id, signal, say);
				} catch (e) {
					slid = `the closing check did not finish (${String(e).slice(0, 160)})`;
				}
				won &&= !slid;
				if (won && c) {
					say("acceptance review: is the intent met, not just the scorecard?");
					({ unmet, closedUp } = await accept(ctx, root, g, c.values));
					won = !unmet;
				}
			}
			await writeExport(root);
			const st = refresh(ctx, root);
			// The drop that trips the grid-search gate summons the judge now: its verdict is ready before the next try.
			const blocked = !kept && X.streakBlocked(st.goals.get(g.id)!);
			if (blocked && hasJudge(ctx)) void judge(ctx, root, g.id, "drop streak");
			let text = kept
				? `KEPT ${exp.id}${byProof ? " by proof" : ""}: ${reason}.${byProof ? " A verified fix, but the scorecard has not moved: it does not count as progress." : ""}`
				: `DROPPED ${exp.id}: ${reason}.${reverted ? ` Reverted in ${reverted.slice(0, 8)}.` : ""}${blocked && hasJudge(ctx) ? ` ${blocked} The independent judge is reviewing now; its verdict arrives as a message before your next experiment.` : ""}`;
			if (won) text += `\n${achievedText(st, ctx, g, closedUp)}`;
			else {
				// The review's finding is the next step; the tree's routing would only repeat it.
				if (unmet) text += `\n${unmetText(unmet)}`;
				else {
					if (slid) text += `\nEvery target is met, but ${g.id} stays open: ${slid}. Restore it, then confirm with climb_scorecard (same checks).`;
					else if (kept && targetsMet(values)) text += `\nTargets met once but not confirmed on re-measurement.`;
					text += `\n${X.nextAction(st, L.rootOf(st, st.goals.get(g.id)!))}`;
				}
			}
			const used = free0 - disk.free(root);
			if (used > 2 ** 30)
				text += `\nNote: the disk lost ${gib(used)} while this measured (${gib(disk.free(root))} free). If the instrument keeps outputs per run (recordings, logs), keep fewer: measuring stops below ${gib(DISK_MIN)}.`;
			return ok(text);
		})),
	});

	pi.registerTool({
		name: "climb_judge",
		label: "Climb: diagnosis",
		description:
			"Record an honest diagnosis when a goal stalls or a lever keeps failing: why there is no progress and the next move. Where the host runs an independent judge, its verdict (not yours) releases a stall or the drop-streak gate; yours is recorded for it. Without one, yours does. 'stuck' is escalated to the independent judge.",
		parameters: S.obj({
			goal: S.opt(S.str("Goal id; optional")),
			verdict: S.enum(["continue", "pivot", "stuck"], "continue the approach, pivot to another, or stuck (needs a human)"),
			diagnosis: S.str("Why there is no progress, with evidence"),
			next: S.str("The concrete next action"),
		}),
		loadMode: "essential",
		approval: "write",
		execute: logged("climb_judge", async (_id, p: JudgeParams, _s, _u, ctx) => {
			worker(ctx);
			const root = await needRoot(ctx);
			holder(root, ctx);
			const st0 = load(root);
			const stalled = L.roots(st0).filter(r => r.stallPending);
			const g0 = !p.goal && stalled.length === 1 ? stalled[0] : pick(st0, p.goal, x => x.stallPending || x.streak >= X.DROP_STREAK);
			// A stall belongs to the root: a diagnosis of it goes there, or (without a judge) it could never lift.
			const top = L.rootOf(st0, g0);
			const g = top.stallPending && !g0.stallPending && g0.streak < X.DROP_STREAK ? top : g0;
			const independent = hasJudge(ctx);
			const escalate = p.verdict === "stuck" && independent;
			append(root, {
				ts: L.now(),
				kind: "judge",
				goal: g.id,
				by: independent ? "worker" : "fallback",
				verdict: escalate ? "pivot" : p.verdict,
				diagnosis: p.diagnosis,
				next: p.next,
			});
			if (escalate) {
				void judge(ctx, root, g.id, "worker said stuck");
				return ok("Recorded. 'stuck' is decided by the independent judge, now reviewing; keep working meanwhile.");
			}
			const st2 = refresh(ctx, root);
			const after = st2.goals.get(g.id)!;
			return ok(p.verdict === "stuck" ? "Recorded as STUCK: the loop rests until a human or a new commit moves it." : `Recorded. ${X.nextAction(st2, after)}`);
		}),
	});

	pi.registerTool({
		name: "climb_split",
		label: "Climb: split",
		description:
			"Decompose a goal into parts (2-4), each a goal of its own: research, scorecard, experiments and knowledge, rolled up into the parent, which closes as achieved when every part is. Split when one scorecard cannot hold the intent: the parts need different instruments, metrics keep being swapped in and out, or a part must first build a steadier instrument. Parts share the repo: a kept change in one part that regresses another's metric is caught at that part's next experiment.",
		parameters: S.obj({
			goal: S.opt(S.str("Goal to split; optional when one goal is active")),
			parts: S.arr(S.obj({ intent: S.str("What this part must achieve: one measurable thing"), why: S.opt(S.str("Why it is a separate part")) }), "2-4 parts"),
		}),
		loadMode: "essential",
		execute: logged("climb_split", async (_id, p: SplitParams, _s, _u, ctx) => {
			worker(ctx);
			const root = await needRoot(ctx);
			holder(root, ctx);
			const st = load(root);
			const g = pick(st, p.goal);
			const busy = X.openIn(st, g);
			if (busy) throw new Error(`Experiment ${busy.open!.id} on ${busy.id} is open; finish it with climb_measure before splitting.`);
			if (L.depth(st, g) + 1 > X.MAX_DEPTH) {
				const home = g.parent ? st.goals.get(g.parent) : undefined;
				throw new Error(
					`${g.id} is ${L.depth(st, g)} levels deep, the deepest a part goes. Climb it with one scorecard (up to ${X.MAX_METRICS} metrics, holds included)${home ? `, or add what it needs beside it: climb_split on ${home.id} (it already has parts, so one more is fine)` : ""}.`,
				);
			}
			const open = L.openParts(st, g).length;
			const intents = (p.parts ?? []).map(x => x.intent?.trim()).filter(Boolean);
			if (intents.length !== (p.parts ?? []).length || new Set(intents).size !== intents.length) throw new Error("Each part needs its own non-empty intent.");
			// A goal splits into at least two parts; one already split may add a single part.
			if (!intents.length || (!L.parts(st, g).length && intents.length < 2) || open + intents.length > X.MAX_PARTS)
				throw new Error(`A split makes 2-${X.MAX_PARTS} parts (${g.id} has ${open} open). Focus: fewer, sharper parts.`);
			const taken = new Set(st.goals.keys());
			const ids = intents.map(intent => {
				const id = X.slug(intent, taken);
				taken.add(id);
				return id;
			});
			append(root, ...p.parts.map((x, i) => ({ ts: L.now(), kind: "goal" as const, goal: ids[i], intent: intents[i], cfg: g.cfg, parent: g.id, why: x.why, harness })));
			const after = refresh(ctx, root);
			return ok(`Split ${g.id} into ${ids.join(", ")}. Each part is a goal: probe it, give it a scorecard, climb it (pass goal: <part> to the climb tools).\n${X.nextAction(after, after.goals.get(g.id)!)}`);
		}),
	});

	pi.registerTool({
		name: "climb_learn",
		label: "Climb: learn",
		description:
			"Record durable knowledge for a goal: a fact (true about the system or the instrument, with numbers), a trap (X looks like Y; check Z), or a dead end (an approach shown not to work, with its experiments as evidence). It survives compaction and restarts, is repeated with your next steps and shown to the judge, and goes to the export for dashboards and other agents. One finding per call.",
		parameters: S.obj({
			goal: S.opt(S.str("Goal id; optional when one goal is active")),
			kind: S.enum(["fact", "trap", "dead-end"], "fact, trap, or dead-end"),
			text: S.str("The finding, one or two sentences"),
			evidence: S.opt(S.str("Experiment ids, commits, files or numbers that back it")),
		}),
		loadMode: "essential",
		approval: "write",
		execute: logged("climb_learn", async (_id, p: LearnParams, _s, _u, ctx) => {
			worker(ctx);
			const root = await needRoot(ctx);
			holder(root, ctx);
			const st = load(root);
			// A finished part's lessons still serve its siblings: any known goal can learn.
			const g = p.goal && st.goals.has(p.goal) ? st.goals.get(p.goal)! : pick(st, p.goal);
			const text = p.text?.trim() ?? "";
			if (!text || text.length > 600) throw new Error("A finding is one or two sentences (1-600 characters).");
			if (!["fact", "trap", "dead-end"].includes(p.kind)) throw new Error('kind is "fact", "trap" or "dead-end".');
			if (L.knowledge(st, g).some(l => l.text === text)) return ok(`Already recorded for ${g.id}.`);
			append(root, { ts: L.now(), kind: "learn", goal: g.id, type: p.kind, text, evidence: p.evidence?.trim() || undefined });
			const n = L.knowledge(load(root), L.rootOf(load(root), g)).length;
			return ok(`Recorded ${p.kind} for ${g.id} (${n} findings in this goal's tree).`);
		}),
	});

	pi.registerTool({
		name: "climb_status",
		label: "Climb: status",
		description: "Read the climb ledger: goals, scorecards, best values vs targets, experiments, levers, judge verdicts, and the next obligation.",
		parameters: S.obj({}),
		loadMode: "essential",
		approval: "read",
		async execute(_id, _p, _s, _u, ctx) {
			ctxRef = ctx;
			const root = await needRoot(ctx);
			const st = load(root);
			return ok([X.report(st), efficiency(root), L.roots(st).map(g => X.nextAction(st, g)).join("\n")].filter(Boolean).join("\n\n"));
		},
	});

	// --- user command ------------------------------------------------------------------

	const USAGE =
		"Autonomous hill-climb. /climb <intent> [--beat 30m] [--poke-max 3] starts a goal · /climb shows progress · beat · judge [goal] · pause · resume · done [goal] · export [path] · panel · move <path> · compact";
	pi.registerCommand("climb", {
		description: USAGE,
		handler: async (args, ctx) => {
			ctxRef = ctx;
			// "help" is never a goal.
			if (/^(help|-h|--help|\?)$/i.test(args.trim())) return ctx.ui.notify(USAGE, "info");
			const root = await repoRoot(ctx.cwd);
			if (!root) return ctx.ui.notify("climb needs a git repository with a commit: git is the source of truth.", "error");
			const words = args.trim().split(/\s+/).filter(Boolean);
			const sub = words[0]?.toLowerCase();
			const st = load(root);
			const one = (id?: string) => {
				try {
					return pick(st, id, undefined, true);
				} catch (e) {
					ctx.ui.notify((e as Error).message, "error");
					return undefined;
				}
			};

			if (!sub || (words.length === 1 && (sub === "status" || sub === "report"))) {
				const text = [X.report(st), efficiency(root)].filter(Boolean).join("\n\n");
				if (ctx.isIdle()) pi.sendMessage({ customType: "climb-report", content: text, display: true });
				else ctx.ui.notify(text, "info");
				return;
			}
			if (words.length === 1 && (sub === "beat" || sub === "poke")) {
				void tick(ctx, true);
				return ctx.ui.notify("climb: heartbeat running…", "info");
			}
			if (sub === "judge" && words.length <= 2) {
				const g = one(words[1]);
				if (!g) return;
				ctx.ui.notify(`climb: judging ${g.id}…`, "info");
				await judge(ctx, root, g.id, "requested by the user");
				return started(ctx);
			}
			if (words.length === 1 && (sub === "pause" || sub === "stop")) {
				append(root, { ts: L.now(), kind: "pause", goal: "*" });
				refresh(ctx, root);
				return ctx.ui.notify("climb paused: no heartbeats, no stop-blocking. /climb resume to continue.", "info");
			}
			if (words.length === 1 && sub === "resume") {
				append(root, { ts: L.now(), kind: "resume", goal: "*" });
				// The human is the unblocker of a STUCK goal: resuming is their verdict to continue.
				for (const g of L.active(st).filter(L.stuck))
					append(root, { ts: L.now(), kind: "judge", goal: g.id, by: "human", verdict: "continue", diagnosis: "resumed by the user", next: "continue climbing" });
				lease(root, ctx, true);
				ensureTimer(ctx);
				const now = refresh(ctx, root);
				for (const g of L.roots(now)) deliver(ctx, X.nextAction(now, g), true);
				return started(ctx);
			}
			if (sub === "done" && words.length <= 2) {
				const g = one(words[1]);
				if (!g) return;
				// Closing a split goal closes its open parts first (deepest first).
				const won = (x: L.Goal) => !!x.card && x.card.metrics.every(m => L.met(m, x.best[m.name]));
				const tree = L.subtree(st, g).filter(x => !x.done).reverse();
				for (const x of tree) append(root, { ts: L.now(), kind: "done", goal: x.id, result: won(x) ? "achieved" : "abandoned", values: x.best });
				// A dropped part no longer counts, so its siblings may now complete the parent.
				const up = g.parent ? await rollUp(ctx, root, g.id) : [];
				await writeExport(root);
				const now = refresh(ctx, root);
				if (!L.active(now).length) stopTimer(ctx);
				return ctx.ui.notify(`climb ${tree.map(x => x.id).join(", ")} closed (${won(g) ? "achieved" : "abandoned"})${up.length ? `; ${up.join(", ")} achieved` : ""}.`, "info");
			}
			if (words.length === 1 && sub === "panel") {
				await writeExport(root);
				return ctx.ui.notify(`climb panel: ${path.join(root, L.DIR, "panel.html")} (open it in a browser; it is rewritten after every decision)`, "info");
			}
			if (sub === "export" && words.length <= 2) {
				const x = await writeExport(root, words[1] ? path.resolve(ctx.cwd, words[1]) : undefined);
				return ctx.ui.notify(`climb export: ${x.file} (${x.rows} metric rows, ${x.findings} findings; schema ${E.SCHEMA})`, "info");
			}
			// A climb follows its checkout: carry the ledger to a clean worktree when this one is shared or dirty.
			if (sub === "move" && words.length === 2) {
				const dest = await repoRoot(path.resolve(ctx.cwd, words[1].replace(/^~(?=\/|$)/, os.homedir())));
				if (!dest) return ctx.ui.notify(`climb move: ${words[1]} is not a git checkout.`, "error");
				if (dest === root) return ctx.ui.notify("climb move: that is this checkout.", "error");
				if (L.read(dest).length) return ctx.ui.notify(`climb move: ${dest} already has a climb ledger (${path.join(dest, L.DIR)}); move it aside first.`, "error");
				const d = await dirty(dest);
				if (d) return ctx.ui.notify(`climb move: ${dest} has uncommitted changes; the climb needs a clean checkout:\n${d}`, "error");
				fs.mkdirSync(path.join(dest, L.DIR), { recursive: true });
				for (const f of ["oracle.jsonl", "trace.jsonl"]) if (fs.existsSync(path.join(root, L.DIR, f))) fs.copyFileSync(path.join(root, L.DIR, f), path.join(dest, L.DIR, f));
				await ensureExcluded(dest);
				// This copy rests: no heartbeats or stop-blocking here once the climb lives there. This session follows it at once.
				append(root, { ts: L.now(), kind: "pause", goal: "*" });
				fs.writeFileSync(path.join(root, L.DIR, AWAY), JSON.stringify({ to: dest, goal: "*" }));
				away.set(root, dest);
				release(root, ctx);
				lease(dest, ctx, true);
				ensureTimer(ctx);
				refresh(ctx, dest);
				return ctx.ui.notify(`climb moved to ${dest}: this session climbs there now, no restart. Edit and commit under ${dest}.`, "info");
			}
			if (words.length === 1 && sub === "compact") {
				const before = L.read(root);
				const after = L.compact(before);
				L.rewrite(root, after);
				return ctx.ui.notify(`climb ledger compacted: ${before.length} → ${after.length} entries.`, "info");
			}

			let beat_s = 1800;
			let poke_max = 3;
			const rest: string[] = [];
			for (let i = 0; i < words.length; i++) {
				if (words[i] === "--beat") {
					const s = X.parseDuration(words[++i] ?? "");
					if (!s || s < 5) return ctx.ui.notify("--beat takes a duration like 30m, 90s, 1h (min 5s).", "error");
					beat_s = s;
				} else if (words[i] === "--poke-max") {
					const n = Number(words[++i]);
					if (!(n >= 1)) return ctx.ui.notify("--poke-max takes a number ≥ 1.", "error");
					poke_max = Math.floor(n);
				} else rest.push(words[i]);
			}
			const intent = rest.join(" ");
			if (!intent) return ctx.ui.notify("Usage: /climb <intent> [--beat 30m] [--poke-max 3]", "error");
			if (!(await head(root))) return ctx.ui.notify("climb needs at least one commit.", "error");
			const id = X.slug(intent, new Set(st.goals.keys()));
			// A live session already climbing this checkout shares its tree, its benchmarks and its ledger: a second goal
			// taking the lease mid-measurement (a Claude Code session in voice's checkout, during an omp x6) breaks both.
			// This one climbs in a checkout of its own instead, and only this session follows it there.
			let home = root;
			if (!lease(root, ctx)) {
				const busy = L.active(st).find(x => x.open);
				try {
					home = await ownCheckout(root, id);
				} catch (e) {
					return ctx.ui.notify(`Another live session is climbing this checkout, and ${(e as Error).message}`, "error");
				}
				away.set(root, home);
				ctx.ui.notify(`Another live session is climbing ${root}${busy?.open ? ` (${busy.open.id} open on ${busy.id})` : ""}, so this goal climbs in its own checkout: ${home}. Edit and commit there.`, "info");
			}
			// The user's new intent is never refused for the cap: it supersedes the goal whose tree saw no work the longest
			// (voice's "FUCKING CLIMB BEST SPEECH PIPELINE" was refused at 19:05 for a 3-day-old tree, and only the worker heard it).
			// A goal in its own checkout (another live session climbs this one) has no cap to meet.
			let superseded = "";
			const tops = home === root ? L.roots(st) : [];
			if (tops.length >= X.MAX_GOALS) {
				const last = (g: L.Goal) => Math.max(g.seq, ...L.subtree(st, g).map(x => Math.max(x.workSeq, x.seq)));
				const old = tops.filter(t => !L.subtree(st, t).some(x => x.open)).sort((a, b) => last(a) - last(b))[0];
				if (!old) return ctx.ui.notify(`${X.MAX_GOALS} goals are active, each with an experiment open: measure or abandon one (climb_measure), or /climb done <goal>, then start this one.`, "error");
				const since = L.read(root)[last(old)]?.ts.slice(0, 16).replace("T", " ");
				for (const x of L.subtree(st, old).filter(x => !x.done).reverse())
					append(root, { ts: L.now(), kind: "done", goal: x.id, result: "abandoned", values: x.best, why: `superseded by the user's new goal: ${intent.slice(0, 120)}` });
				superseded = ` ${old.id} (no work since ${since ?? "long ago"}) is closed to keep the focus on ${X.MAX_GOALS} goals; its record stays in the ledger.`;
			}
			await ensureExcluded(home);
			const fresh = load(home);
			append(home, { ts: L.now(), kind: "goal", goal: id, intent, cfg: { poke_max, beat_s }, harness });
			if (fresh.paused) append(home, { ts: L.now(), kind: "resume", goal: "*" });
			mine.add(id);
			lease(home, ctx, true);
			ensureTimer(ctx);
			const g = refresh(ctx, home).goals.get(id)!;
			ctx.ui.notify(`climb ${id} started · heartbeat every ${Math.round(beat_s / 60) || `${beat_s}s`}${beat_s >= 60 ? "m" : ""} · judge after ${poke_max} stale beats.${superseded}`, "info");
			pi.sendUserMessage(X.researchBrief(g));
			await started(ctx);
		},
	});
}

// --- tool param shapes + schema builder (zod on omp, TypeBox on upstream pi) ------------

interface GoalParam {
	goal?: string;
}
interface ScorecardParams extends GoalParam {
	metrics: { name: string; cmd: string; dir: L.Dir; target?: number; hold?: boolean; unit?: string; noise?: number; samples?: number; timeout_s?: number; parallel?: boolean | number }[];
	guard?: string;
	frozen?: string[];
	parked?: string[];
	axioms?: string[];
	own_checkout?: boolean;
}
interface ProbeParams extends GoalParam {
	name: string;
	cmd: string;
	note?: string;
	timeout_s?: number;
}
interface SplitParams extends GoalParam {
	parts: { intent: string; why?: string }[];
}
interface LearnParams extends GoalParam {
	kind: L.LearnKind;
	text: string;
	evidence?: string;
}
interface MeasureParams extends GoalParam {
	abandon?: string;
}
interface ExperimentParams extends GoalParam {
	lever: string;
	hypothesis: string;
	prediction: string;
	proof?: string;
}
interface JudgeParams extends GoalParam {
	verdict: L.Verdict;
	diagnosis: string;
	next: string;
}

// biome-ignore lint/suspicious/noExplicitAny: schema objects are host-defined
type Schema = any;
interface Builder {
	obj(props: Record<string, Schema>): Schema;
	str(desc: string): Schema;
	num(desc: string): Schema;
	bool(desc: string): Schema;
	arr(item: Schema, desc: string): Schema;
	enum(values: string[], desc: string): Schema;
	opt(s: Schema): Schema;
}

async function schemas(pi: ExtensionAPI): Promise<Builder> {
	const host = pi as unknown as { zod?: Schema; typebox?: Schema };
	const z = host.zod;
	if (z)
		return {
			obj: p => z.object(p),
			str: d => z.string().describe(d),
			num: d => z.number().describe(d),
			bool: d => z.boolean().describe(d),
			arr: (i, d) => z.array(i).describe(d),
			enum: (v, d) => z.enum(v).describe(d),
			opt: s => s.optional(),
		};
	const typebox = "@sinclair/typebox"; // upstream pi bundles it; resolved only off-omp
	const T = host.typebox?.Type ?? host.typebox ?? (await import(typebox)).Type;
	return {
		obj: p => T.Object(p),
		str: d => T.String({ description: d }),
		num: d => T.Number({ description: d }),
		bool: d => T.Boolean({ description: d }),
		arr: (i, d) => T.Array(i, { description: d }),
		enum: (v, d) => T.Union(v.map(x => T.Literal(x)), { description: d }),
		opt: s => T.Optional(s),
	};
}
