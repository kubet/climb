# /climb

<p align="center"><img src="assets/climb.svg" alt="/climb: a little pi climbs a mountain — probe, scorecard, experiment, measure; kept steps go up, dropped ones are reverted; the summit is achieved and reviewed" width="860"></p>

Autonomous hill-climbing for coding agents: [pi](https://github.com/badlogic/pi-mono), [omp](https://github.com/can1357/oh-my-pi) and [Claude Code](https://code.claude.com). You say what should get better. The agent picks metrics and targets, then keeps trying changes until the targets are met.

The agent writes the code. The extension measures, decides and keeps the record, so the agent cannot grade its own work or quit early.

## Install

**pi**

```bash
pi install git:github.com/kubet/climb
```

**omp**

```bash
omp plugin install git+ssh://git@github.com/kubet/climb.git
```

**Claude Code** (needs [bun](https://bun.sh))

```bash
claude plugin marketplace add kubet/climb
claude plugin install climb@climb
```

From a local checkout: `claude --plugin-dir ./climb`. Approve the climb tools when asked, or allow `mcp__plugin_climb_climb__*` in your permissions: a headless `claude -p` refuses tools nobody approved.

On omp, a stop hook keeps the agent working and the judge and acceptance review run as independent side turns. pi has neither, so there the heartbeat drives the loop, the agent's own diagnosis stands in for the judge, and achieved goals are marked unreviewed.

On Claude Code the same extension runs inside the plugin's MCP server, one per session, and the plugin's hooks call it: the Stop hook keeps Claude working, and the judge and acceptance review are a separate `claude -p` with no tools. The command is `/climb:climb` (Claude Code namespaces plugin commands). Claude Code cannot start a turn on its own, so a session the climb let rest resumes on your next message. It moves tool calls longer than two minutes to the background. While a measurement runs, the plugin refuses only changes to the checkout it measures; reading, research and work elsewhere go on. `CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS=0` makes Claude wait for it as omp does. An update needs no restart, on any host. When Claude Code installs a newer climb, or the source omp and pi load from changes, the running session swaps it in between tool calls (never during a measurement), keeps what the climb holds in memory, and says so. That's from 0.3.5 on Claude Code and 0.4.0 on omp and pi; a session started on an older climb restarts once. Every goal and scorecard records its harness (`omp`, `pi`, `claude-code`), and so does each `export.json` row, so one scorecard climbed by two harnesses compares from the exports.

Needs a git repo with at least one commit. A goal climbs where its instrument runs: metrics that `cd` into another repo take the goal there. A checkout another session has dirtied, or one another live climb holds, gets the goal a checkout of its own beside it (`<repo>-climb`). The session follows the goal there with no restart, and so does a session restarted in the old checkout.

## Use

```
/climb make the API p50 under 50ms   start a goal (optional: --beat 30m --poke-max 3)
/climb                               progress report
/climb pause | resume                stop / restart the loop
/climb done [goal]                   close a goal
/climb panel                         write .climb/panel.html
/climb move <path>                   carry the climb to another checkout (no restart)
```

After a restart, continuing the session (`pi -c`, `omp -c`, `claude -c`) picks the climb up from its ledger.

## What happens

1. **Probe**: the agent finds candidate metrics; the extension runs each and records the number.
2. **Scorecard**: up to 3 metrics with targets; the extension measures baseline and noise (A/A).
3. **Experiment**: one lever, one hypothesis; the agent edits and commits.
4. **Measure**: the extension measures the commit (A B B A against the base when it's close). Beat the noise: **kept**. Otherwise: **dropped** and auto-reverted. Back to 3.
5. **Summit**: every target met, measured again, then an independent review of the intent: **achieved**.

Meanwhile a heartbeat checks every 30 min; three quiet beats call an independent judge (continue / pivot / stuck). The agent cannot stop while a goal is open.

## Rules the extension enforces

- **It measures, on commits.** The agent never reports its own numbers. A run that crashes decides nothing.
- **Noise is measured, not guessed.** A gain must beat it. Borderline or drifting metrics are re-run interleaved with the base commit (A B B A), so machine drift cancels out. A metric whose pairs are noisier than the whole way to its target can keep nothing: experiments on it wait until the instrument is steadier (or carry a proof).
- **One run, many numbers.** Metrics with the same command share each run; the command prints one `name=value` line per metric. A metric marked `parallel: k` runs k at once, each with its own `$CLIMB_SLOT` for its port: k samples in plain runs, and k/2 pairs with both sides at once (drift cancels exactly).
- **A streak cannot slide, and nothing unchecked is kept.** Each keep on a proof only checks "no worse than the step before". From the third in a row, a keep is also measured in pairs against where the streak started, pairing (up to 20) until the call is clear. A slide beyond the scorecard's noise stops it. So does an instrument that can't see one: too wide, or two-valued (a jury that picks by side). Those choices go to the user.
- **It steers itself.** When the acceptance review holds a goal open and the worker leaves it for the judge's count of beats, the review's unmet requirement becomes a part of its own. The judge calls a climb STUCK only for what only you can do (credentials, money, a choice that is yours); otherwise it names the next action.
- **Nothing is measured twice.** A result kept on its proof was not chosen for its numbers, so its runs are the next control. A drifting metric skips the control (its pairs measure the base afresh). Pairs stop at 3 when they already decide with room to spare.
- **Measuring resumes.** A measurement that is cut off keeps its finished runs and pairs; calling again continues, and cannot re-roll them.
- **The disk never fills.** Measuring stops below 2 GiB free, deciding nothing; a measurement that used over 1 GiB says so.
- **Drops revert themselves.** An experiment that touches the benchmark is dropped.
- **Holds guard.** A `hold: true` metric ("no slower") has no target; a real regression drops the experiment.
- **Proofs.** An experiment can carry a check that fails before the change and passes after; that keeps a fix the metrics are too coarse to see.
- **Focus.** One open experiment, at most 3 metrics per goal. Three drops in a row call the judge.
- **Big goals split.** `climb_split` makes 2-4 parts, each with its own scorecard. `climb_learn` records facts, traps and dead ends that survive restarts.
- **Achieved means checked.** Targets met twice, then an independent review of the intent. If no review could run, the goal is marked unreviewed.

## Files

Everything lives in `.climb/` (excluded from git):

| File | What |
|---|---|
| `oracle.jsonl` | every decision, append-only |
| `trace.jsonl` | every run and tool call, with timing and refusals |
| `panel.html` | goal tree, metrics vs targets, experiments |
| `export.json` | evidence rows (benchmaxx schema `climb.export/1`) |

Set `CLIMB_SINK=<https url or shell command>` to stream each decision out. Other extensions can listen with `pi.events.on("climb", …)`.

## Develop

```bash
bun test
```
