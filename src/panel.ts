// .climb/panel.html: the climb as a briefing, one static page rewritten after every decision.
// Read top to bottom it answers, in order: are we winning, what is happening now, how far is each
// part from its targets, what was decided and why, what was learned, where the time went.
// No scripts, no external assets; hover values ride on SVG <title>s.
import type { Row, build } from "./export";
import { type Goal, type Metric, type State, epoch, met, parts, subtree } from "./ledger";
import { goalPct, openIn, progressPct, reached } from "./logic";
import { dur, type summary } from "./trace";

type Summary = ReturnType<typeof summary>;
type Data = ReturnType<typeof build>;

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const num = (v: number | undefined) =>
	v === undefined || !Number.isFinite(v) ? "—" : Math.abs(v) >= 10_000 ? `${(v / 1000).toFixed(1)}K` : Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 1 ? String(Number(v.toFixed(1))) : String(Number(v.toPrecision(2)));
const ago = (ts: string | undefined, now: number) => (ts ? `${dur(Math.max(0, now - epoch(ts)))} ago` : "never");
const pct = (x: number) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(0)}%`;

const STYLE = `
.cp{color-scheme:light;--page:#f9f9f7;--surface:#fcfcfb;--ink:#0b0b0b;--ink2:#52514e;--muted:#898781;--grid:#e1e0d9;--axis:#c3c2b7;--ring:rgba(11,11,11,.10);
--accent:#2a78d6;--track:#cde2fb;--good:#0ca30c;--goodText:#006300;--warning:#fab219;--serious:#ec835a;--critical:#d03b3b}
@media (prefers-color-scheme:dark){:root:where(:not([data-theme="light"])) .cp{color-scheme:dark;--page:#0d0d0d;--surface:#1a1a19;--ink:#f0efec;--ink2:#c3c2b7;--grid:#2c2c2a;--axis:#383835;--ring:rgba(255,255,255,.10);--accent:#3987e5;--track:rgba(57,135,229,.16);--goodText:#0ca30c}}
:root[data-theme="dark"] .cp{color-scheme:dark;--page:#0d0d0d;--surface:#1a1a19;--ink:#f0efec;--ink2:#c3c2b7;--grid:#2c2c2a;--axis:#383835;--ring:rgba(255,255,255,.10);--accent:#3987e5;--track:rgba(57,135,229,.16);--goodText:#0ca30c}
*{box-sizing:border-box}html,body{margin:0}
.cp{background:var(--page);color:var(--ink);font:14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;min-height:100vh;padding:28px 16px 48px}
.cp main{max-width:1080px;margin:0 auto}
.eyebrow{color:var(--muted);font-size:12px;letter-spacing:.04em;text-transform:uppercase;margin:0 0 6px;font-weight:500}
h1{font-size:22px;line-height:1.3;margin:0 0 6px;font-weight:600}h2{font-size:15px;margin:32px 0 12px;font-weight:600}h3{font-size:15px;margin:0;font-weight:600}
.lede{color:var(--ink2);font-size:15px;margin:0;max-width:820px}
.card{background:var(--surface);border:1px solid var(--ring);border-radius:12px;padding:16px 18px}
.hero{display:grid;grid-template-columns:minmax(200px,1fr) 3fr;gap:14px;margin-top:22px;align-items:start}
.hero .big{font-size:56px;line-height:1;font-weight:600;margin:6px 0 8px}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:14px;align-items:start}
.clamp{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:3;overflow:hidden}.clamp2{-webkit-line-clamp:2}
.goaltext{margin:10px 0 0;color:var(--muted);font-size:13px;max-width:820px}.goaltext summary{cursor:pointer;width:max-content}
.tile .label{color:var(--ink2);font-size:13px}.tile .value{font-size:26px;font-weight:600;margin:4px 0 2px}.tile .sub{color:var(--muted);font-size:12px}
.now{margin-top:14px;border-left:3px solid var(--accent)}
.now .what{font-weight:600}.now p{margin:4px 0 0;color:var(--ink2)}.now code{font-size:12px}
.chip{display:inline-flex;align-items:center;gap:5px;font-size:12px;font-weight:600;padding:2px 9px;border-radius:999px;white-space:nowrap;vertical-align:middle}
.chip.good{background:var(--good);color:#fff}.chip.critical{background:var(--critical);color:#fff}.chip.warning{background:var(--warning);color:#0b0b0b}
.chip.neutral{background:transparent;color:var(--ink2);box-shadow:inset 0 0 0 1px var(--axis)}
.parts{display:grid;gap:14px}.part-head{display:flex;flex-wrap:wrap;gap:10px;align-items:baseline;justify-content:space-between}
.part-head .pct{font-size:20px;font-weight:600}.intent{color:var(--ink2);margin:4px 0 12px;font-size:13px}
.m{display:grid;grid-template-columns:minmax(150px,1.3fr) minmax(170px,1.5fr) 160px;gap:6px 18px;align-items:center;padding:10px 0;border-top:1px solid var(--grid)}
.m .name{font-weight:600;overflow-wrap:anywhere}.m .unit{color:var(--muted);font-size:12px;font-weight:400}
.m .nums{font-variant-numeric:tabular-nums;color:var(--ink2);font-size:13px}.m .nums b{color:var(--ink)}
.meter{height:8px;border-radius:4px;background:var(--track);overflow:hidden;margin-top:6px}.meter span{display:block;height:100%;background:var(--accent);border-radius:0 4px 4px 0}
.meter.done span{background:var(--good)}
.history{color:var(--muted);font-size:12px;margin:10px 0 0}
.held{border-left:2px solid var(--warning);padding:2px 0 2px 10px;margin:12px 0 0;font-size:13px;color:var(--ink2)}.held b{color:var(--ink)}
.spark polyline{fill:none;stroke:var(--accent);stroke-width:2;stroke-linejoin:round;stroke-linecap:round}
.spark .target{stroke:var(--axis);stroke-width:1;stroke-dasharray:3 3}.spark .end{fill:var(--accent);stroke:var(--surface);stroke-width:2}.spark .hit{fill:transparent}
.feed{padding:0;margin:0}.feed li{list-style:none;display:grid;grid-template-columns:128px 1fr;gap:2px 14px;padding:12px 18px;border-top:1px solid var(--grid)}.feed>li:first-child{border-top:0}
.feed .when{color:var(--muted);font-size:12px;font-variant-numeric:tabular-nums}.feed .when .chip{margin-top:4px}.feed .head{font-weight:600}.feed .moves{font-variant-numeric:tabular-nums;font-size:13px;color:var(--ink2)}
.feed .where{color:var(--muted);font-weight:400;font-size:12px;margin-left:6px}.feed .moves .win{color:var(--goodText);font-weight:600}.feed .moves .loss{color:var(--critical);font-weight:600}
.feed details{grid-column:2;color:var(--muted);font-size:12px}.feed summary{cursor:pointer;width:max-content}
.feed .feed li{padding:12px 0}
.know{padding:0;margin:0}.know li{list-style:none;padding:9px 0;border-top:1px solid var(--grid);display:grid;grid-template-columns:104px 1fr;gap:10px}.know li:first-child{border-top:0}
.know .goal{color:var(--muted);font-size:12px}
.bars{display:grid;grid-template-columns:minmax(120px,auto) 1fr auto;gap:8px 12px;align-items:center;font-size:13px}
.bars .bar{height:12px;border-radius:0 4px 4px 0;background:var(--accent)}.bars .bar.waste{background:var(--serious)}
.bars .v{font-variant-numeric:tabular-nums;color:var(--ink2);text-align:right}
.two{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:14px}
.facts{color:var(--ink2);font-size:13px;margin:12px 0 0;padding-left:18px}
footer{color:var(--muted);font-size:12px;margin-top:32px}
@media (max-width:640px){.hero{grid-template-columns:1fr}.m{grid-template-columns:1fr}.feed li,.know li{grid-template-columns:1fr}.feed details{grid-column:1}}
`;

/** A metric's measured path with the target as a threshold line; every point carries its value on hover. */
function spark(g: Goal, m: Metric): string {
	const pts = (g.series.get(m.name) ?? []).slice(-24);
	if (pts.length < 2) return "";
	const w = 160;
	const h = 40;
	const vals = pts.map(p => p.v);
	const target = m.hold ? undefined : m.target;
	const all = target !== undefined && Number.isFinite(target) ? [...vals, target] : vals;
	const lo = Math.min(...all);
	const hi = Math.max(...all);
	const x = (i: number) => 6 + (i / (pts.length - 1)) * (w - 12);
	const y = (v: number) => (hi === lo ? h / 2 : h - 6 - ((v - lo) / (hi - lo)) * (h - 12));
	const line = pts.map((p, i) => `${x(i).toFixed(1)},${y(p.v).toFixed(1)}`).join(" ");
	const goal =
		target !== undefined && Number.isFinite(target)
			? `<line class="target" x1="0" x2="${w}" y1="${y(target).toFixed(1)}" y2="${y(target).toFixed(1)}"><title>target ${num(target)}</title></line>`
			: "";
	const unit = m.unit ? ` ${m.unit.split(/[,(]/)[0].trim()}` : "";
	const hits = pts
		.map((p, i) => `<circle class="hit" cx="${x(i).toFixed(1)}" cy="${y(p.v).toFixed(1)}" r="9"><title>${esc(`${num(p.v)}${unit} · ${new Date(p.t).toISOString().slice(5, 16).replace("T", " ")} UTC`)}</title></circle>`)
		.join("");
	const last = pts.length - 1;
	return `<svg class="spark" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-label="${esc(m.name)} over time">${goal}<polyline points="${line}"/><circle class="end" cx="${x(last).toFixed(1)}" cy="${y(vals[last]).toFixed(1)}" r="4"/>${hits}</svg>`;
}

function metricRow(g: Goal, m: Metric): string {
	const best = g.best[m.name];
	const reached = met(m, best);
	const progress = m.hold ? undefined : Math.max(0, Math.min(100, progressPct(m, best)));
	const meter =
		progress === undefined
			? ""
			: `<div class="meter${reached ? " done" : ""}" role="img" aria-label="${progress}% of the way to target"><span style="width:${progress}%"></span></div>`;
	return `<div class="m"><div class="name">${reached ? `<span class="chip good">✓ met</span> ` : ""}${esc(m.name)}${m.unit ? `<div class="unit">${esc(m.unit)}</div>` : ""}</div>
<div><div class="nums">${num(g.origin?.[m.name]?.cmd === m.cmd ? g.origin[m.name].value : m.baseline)} → <b>${num(best)}</b>${m.hold ? " · hold: must not regress" : ` / target ${num(m.target)} · ${progress}%`} · noise ±${(m.noise * 100).toFixed(m.noise < 0.1 ? 1 : 0)}%</div>${meter}</div>
<div>${spark(g, m)}</div></div>`;
}

function stateChip(st: State, g: Goal): string {
	if (g.done)
		return g.done.result !== "achieved"
			? `<span class="chip neutral">closed</span>`
			: g.done.unreviewed
				? `<span class="chip warning" title="the acceptance review did not run: ${esc(g.done.unreviewed)}">✓ achieved · unreviewed</span>`
				: `<span class="chip good">✓ achieved</span>`;
	if (g.stallPending) return `<span class="chip warning">⚠ stalled · judge reviewing</span>`;
	if (g.judge?.verdict === "stuck" && g.progressSeq < g.judgeSeq) return `<span class="chip critical">✕ stuck · needs you</span>`;
	const busy = openIn(st, g);
	if (busy) return `<span class="chip neutral">● ${esc(busy.open!.id)} running</span>`;
	if (g.reviewed) return `<span class="chip warning">⚠ ${parts(st, g).length ? "parts achieved" : "targets met"} · review holds it</span>`;
	if (reached(g) && !parts(st, g).length) return `<span class="chip warning">⚠ targets met · not confirmed</span>`;
	return g.card ? `<span class="chip neutral">climbing</span>` : `<span class="chip neutral">researching</span>`;
}

/** What the acceptance review found missing, for a goal it holds open. */
const finding = (g: Goal) => g.reviewed!.diagnosis.replace(/^Every (target is met|part is achieved), but not the intent: /, "");
const held = (g: Goal) => (g.reviewed && !g.done ? `<p class="held"><b>Acceptance review:</b> ${esc(finding(g))} <b>Next:</b> ${esc(g.reviewed.next)}</p>` : "");

function partCard(st: State, g: Goal): string {
	const kids = parts(st, g);
	const body = g.card
		? g.card.metrics.map(m => metricRow(g, m)).join("")
		: `<p class="history">${g.probes.length ? `Researching: ${g.probes.length} candidate metrics probed; latest ${esc(g.probes.slice(-3).map(p => `${p.name} ${num(p.value)}`).join(", "))}` : "Researching: no metric yet"}</p>`;
	const kept = g.results.filter(r => r.verdict === "kept").length;
	return `<section class="card"><div class="part-head"><h3>${esc(g.id)} ${stateChip(st, g)}</h3><span class="pct">${goalPct(st, g)}%</span></div>
<p class="intent clamp clamp2" title="${esc(g.intent)}">${esc(g.intent)}</p>${body}${held(g)}
<p class="history">${g.results.length} experiments, ${kept} kept${kids.length ? ` · split into ${kids.length} parts` : ""}</p></section>`;
}

function feed(rows: Row[], now: number): string {
	const byRecord = new Map<string, Row[]>();
	for (const r of rows) byRecord.set(r.record_id, [...(byRecord.get(r.record_id) ?? []), r]);
	const recs = [...byRecord.values()].sort((a, b) => b[0].decided_at.localeCompare(a[0].decided_at));
	const multi = new Set(rows.map(r => r.group)).size > 1;
	const item = (rs: Row[]) => {
		const r = rs[0];
		const abandoned = r.reason.startsWith("abandoned:");
		const chip = abandoned
			? `<span class="chip neutral">— abandoned</span>`
			: r.verdict === "kept"
				? `<span class="chip good">✓ kept${r.qualification.by_proof ? " by proof" : ""}</span>`
				: `<span class="chip critical">✕ dropped</span>`;
		const moves = rs
			.filter(x => x.after !== undefined && x.before !== undefined)
			.map(x => {
				const g = x.direction === "lower" ? -x.change_percent / 100 : x.change_percent / 100;
				const cls = x.qualification.statistical_win ? "win" : g < -x.noise ? "loss" : "";
				return `<span class="${cls}">${esc(x.metric_id)} ${num(x.before)} → ${num(x.after)} (${pct(g)} vs ±${(x.noise * 100).toFixed(0)}%)</span>`;
			})
			.join("<br>");
		const id = r.record_id.split("/").pop() ?? r.record_id;
		return `<li><div class="when" title="${esc(r.decided_at)}">${esc(ago(r.decided_at, now))}<br>${chip}</div><div><div class="head">${esc(id)} · ${esc(r.scope)}${multi ? ` <span class="where">${esc(r.group)}</span>` : ""}</div><div class="moves">${moves || "not measured"}</div></div><details><summary>why</summary>${esc(r.reason)}</details></li>`;
	};
	const shown = recs.slice(0, 12).map(item).join("");
	const rest = recs.slice(12);
	return `<ul class="card feed">${shown}${rest.length ? `<li><div></div><details><summary>${rest.length} earlier decisions</summary><ul class="feed">${rest.map(item).join("")}</ul></details></li>` : ""}</ul>`;
}

function knowledge(st: State, roots: Goal[]): string {
	const all = roots.flatMap(r => subtree(st, r)).flatMap(g => g.learned.map(l => ({ ...l, where: g.id })));
	if (!all.length) return "";
	const chip = { trap: `<span class="chip warning">⚠ trap</span>`, "dead-end": `<span class="chip neutral">✕ dead end</span>`, fact: `<span class="chip neutral">ℹ fact</span>` };
	const order = { trap: 0, "dead-end": 1, fact: 2 };
	const items = [...all].sort((a, b) => order[a.type] - order[b.type] || b.ts.localeCompare(a.ts)).slice(0, 14);
	return `<h2>What the climb learned</h2><div class="card"><ul class="know">${items.map(l => `<li><div>${chip[l.type]}</div><div>${esc(l.text)}<div class="goal">${esc(l.where)}</div></div></li>`).join("")}</ul></div>`;
}

function time(s: Summary): string {
	if (!s.traced) return "";
	const toolMax = Math.max(1, ...s.byTool.map(([, v]) => v));
	const tools = s.byTool.map(([k, v]) => `<div>${esc(k)}</div><div><div class="bar" style="width:${((v / toolMax) * 100).toFixed(1)}%"></div></div><div class="v">${dur(v)}</div>`).join("");
	const wasteMax = Math.max(1, ...s.wasted.map(w => w.ms));
	const waste = s.wasted
		.slice(0, 6)
		.map(w => `<div>${esc(w.what)} ×${w.n}</div><div><div class="bar waste" style="width:${((w.ms / wasteMax) * 100).toFixed(1)}%"></div></div><div class="v">${dur(w.ms)}</div>`)
		.join("");
	const facts = [
		`${s.runs} benchmark runs (${dur(s.runMs)}), ${s.failedRuns} failed${s.retries ? `, ${s.recovered} of ${s.retries} retries recovered` : ""}`,
		s.reusedRuns ? `${s.reusedRuns} runs reused instead of re-measured: ~${dur(s.savedMs)} saved` : "",
		s.perRun.length ? `per run: ${s.perRun.slice(0, 4).map(p => `${p.metric} ${dur(p.ms)}`).join(", ")}` : "",
		s.flaky.length ? `flaky: ${s.flaky.slice(0, 3).map(f => `${f.metric} failed ${f.bad} of ${f.n}`).join(", ")}` : "",
		s.guard.n ? `guard ${s.guard.n}× at a median ${dur(s.guard.medianMs)}${s.guard.failed ? `, ${s.guard.failed} failed` : ""}` : "",
		s.judge.n ? `judge ${s.judge.n}× at a median ${dur(s.judge.medianMs)}` : "",
	].filter(Boolean);
	return `<h2>Where the time went <span class="eyebrow">· traced over ${dur(s.tracedMs)}</span></h2><div class="two">
<div class="card"><div class="eyebrow">Climb tools · ${dur(s.toolMs)}</div><div class="bars">${tools}</div><ul class="facts">${facts.map(f => `<li>${esc(f)}</li>`).join("")}</ul></div>
<div class="card"><div class="eyebrow">Wasted on refused or failed calls · ${dur(s.wastedMs)}</div>${waste ? `<div class="bars">${waste}</div>` : `<p class="history">Nothing wasted.</p>`}</div></div>`;
}

/** One sentence that answers "are we winning", then the facts behind it. */
function verdict(st: State, root: Goal, now: number): { headline: string; lede: string } {
	const tree = subtree(st, root);
	const leaves = tree.filter(g => g !== root && !parts(st, g).length);
	const achieved = leaves.filter(g => g.done?.result === "achieved").length;
	const wins = tree.flatMap(g => g.results.filter(r => r.verdict === "kept").map(r => ({ r, g }))).sort((a, b) => b.r.ts.localeCompare(a.r.ts));
	const last = wins[0];
	const busy = openIn(st, root);
	const word = root.done
		? root.done.result === "achieved"
			? "Achieved"
			: "Closed"
		: root.stallPending
			? "Stalled: the judge is reviewing"
			: root.judge?.verdict === "stuck" && root.progressSeq < root.judgeSeq
				? "Stuck: it needs you"
				: last && now - epoch(last.r.ts) < 3 * 3_600_000
					? "Climbing"
					: "Working, no recent win";
	const headline = `${word} · ${goalPct(st, root)}% of targets${leaves.length ? ` · ${achieved} of ${leaves.length} parts achieved` : ""}`;
	const lastText = last ? `Last win ${ago(last.r.ts, now)}: ${last.r.exp} on ${last.g.id}, ${last.r.reason.split(";")[0].replace(/\s*\(.*?\)/g, "").slice(0, 140)}.` : "No win yet.";
	// A part closing is news the experiment feed does not carry.
	const closed = tree.filter(g => g !== root && g.done?.result === "achieved").sort((a, b) => b.done!.ts.localeCompare(a.done!.ts))[0];
	const closedText = closed && (!last || closed.done!.ts > last.r.ts) ? `${closed.id} achieved ${ago(closed.done!.ts, now)}. ` : "";
	const waiting = tree.find(g => g.reviewed && !g.done);
	const nowText = busy
		? ` Now: ${busy.open!.id} "${busy.open!.lever}" on ${busy.id}, open ${ago(busy.open!.ts, now).replace(" ago", "")}.`
		: waiting
			? ` Now: ${waiting.id} ${parts(st, waiting).length ? "has every part achieved" : "meets every target"}; the acceptance review wants more first: ${waiting.reviewed!.next}.`
			: "";
	return { headline, lede: `${closedText}${lastText}${nowText}` };
}

export function render(st: State, data: Data, s: Summary, nowMs: number): string {
	const roots = [...st.goals.values()].filter(g => !g.parent && !g.moved && (!g.done || nowMs - epoch(g.done.ts) < 86_400_000));
	const sections = roots
		.map(root => {
			const v = verdict(st, root, nowMs);
			const busy = openIn(st, root);
			const leaves = subtree(st, root).filter(g => g !== root && !parts(st, g).length);
			const tiles = [
				{ label: "Experiments decided", value: String(s.experiments.n), sub: `${s.experiments.kept} kept · ${s.experiments.n - s.experiments.kept} dropped` },
				{ label: "Pace", value: `${s.experiments.perHour.toFixed(1)}/h`, sub: `median ${dur(s.experiments.medianCycleMs)} to a verdict` },
				{ label: "Time wasted", value: dur(s.wastedMs), sub: `${s.refused} refused or failed calls` },
				{ label: "Heartbeat", value: `stale ${root.lastBeat?.stale ?? 0}/${root.cfg.poke_max}`, sub: `every ${dur(root.cfg.beat_s * 1000)}, last ${ago(root.lastBeat?.ts, nowMs)}` },
			];
			const now = busy?.open
				? `<div class="card now"><div class="eyebrow">Now · ${esc(busy.id)} · open ${esc(ago(busy.open.ts, nowMs).replace(" ago", ""))}</div><div class="what">${esc(busy.open.id)} · ${esc(busy.open.lever)}</div><p class="clamp" title="${esc(busy.open.hypothesis)}">${esc(busy.open.hypothesis)}</p><p class="clamp clamp2" title="${esc(busy.open.prediction)}"><b>Predicts:</b> ${esc(busy.open.prediction)}</p>${busy.open.proof ? `<p><b>Proof:</b> <code>${esc(busy.open.proof.cmd)}</code></p>` : ""}</div>`
				: "";
			const history = root.card && leaves.length ? `<p class="history">The scorecard from before the split is history; the parts carry the climb.</p>` : "";
			return `<p class="eyebrow">${esc(root.id)}</p><h1>${esc(v.headline)}</h1><p class="lede">${esc(v.lede)}</p>
<details class="goaltext"><summary>Goal as given</summary>${esc(root.intent)}</details>
<div class="hero"><div class="card"><div class="eyebrow">Progress toward targets</div><div class="big">${goalPct(st, root)}%</div><div class="history">${leaves.length ? `mean of its ${leaves.length} parts` : "its slowest metric"}</div></div>
<div class="tiles">${tiles.map(t => `<div class="card tile"><div class="label">${esc(t.label)}</div><div class="value">${esc(t.value)}</div><div class="sub">${esc(t.sub)}</div></div>`).join("")}</div></div>
${now}<h2>${leaves.length ? "Parts" : "Scorecard"}</h2><div class="parts">${(leaves.length ? leaves : [root]).map(g => partCard(st, g)).join("")}</div>${history}`;
		})
		.join("");
	return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Climb · ${esc(data.repo.name)}</title><style>${STYLE}</style></head>
<body class="cp"><main>${sections || `<h1>No goals</h1><p class="lede">Start one in omp: /climb &lt;intent&gt;</p>`}
<h2>Decisions</h2>${data.metric_rows.length ? feed(data.metric_rows, nowMs) : `<p class="history">No experiment decided yet.</p>`}
${knowledge(st, roots)}${time(s)}
<footer>${esc(data.repo.name)} · updated ${esc(data.generated_at.slice(0, 16).replace("T", " "))} UTC · evidence in .climb/export.json (${esc(data.schema)}), .climb/oracle.jsonl, .climb/trace.jsonl</footer></main></body></html>`;
}
