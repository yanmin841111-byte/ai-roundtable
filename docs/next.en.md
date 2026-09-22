[繁體中文](next.md) | **English**

# What is next

Work that has been decided on but not done yet. It is written down so it can be picked
up from another machine, or after a gap — knowing *why* something matters is as
important as knowing *which files to touch*, so both are here.

When an item is done, delete it from this file and record it in
[CHANGELOG.en.md](../CHANGELOG.en.md).

## After switching machines, check the environment still works

```bash
npm ci
npm run typecheck   # types
npm test            # unit tests (currently 47)
npm run e2e         # end-to-end (currently 47 checks)
npm run harness:ui  # drives the real Electron app through UI scenarios, saves screenshots
```

`npm run harness:ui` is the slowest but the most important one: unit tests run under
plain node and cannot see that `process.execPath` is Electron inside the app. The first
48 runs of eval experiment 5 were discarded over exactly that class of difference.

---

## 1. The result card does not show counterexample evidence yet

**Today**: counterexample results (confirmed / unsubstantiated / unusable, and whether
they turned green after the repair) only appear in system messages and ratchet messages.
Those are saved to the transcript and text export, so nothing is lost — but the
**result card does not carry them**.

**Why it matters**: the result card is this product's evidence surface — the verification
record, the file changes and the outstanding items all live there, and both manual
sign-off and the JSON export are built from it. Counterexamples are evidence of the same
kind (executed by the app, no model in the loop), so leaving them out is a hole in the
evidence chain: someone reading the result card cannot see that two counterexamples were
confirmed and only one of them now passes.

**Files to touch**:

| File | What |
| --- | --- |
| [src/ipc-types.ts](../src/ipc-types.ts) | Add `counterexamples?` to `TaskSummary`, shaped like `TaskVerification`: title, who raised it, confirmation state, post-repair state, bounded output |
| [src/orchestrator.ts](../src/orchestrator.ts) | `pushTaskSummary` should carry `counterexamples` (post-execution) and `fix.counterexamples` (post-repair) |
| [renderer/task-card.ts](../renderer/task-card.ts) | Render alongside the verification record, reusing the existing "evidence before conclusions" layout |
| [renderer/i18n.ts](../renderer/i18n.ts) | Copy in both languages |
| [src/flow/task-summary.ts](../src/flow/task-summary.ts) | The text export needs it too |
| [test/harness/scenarios/counterexample.ts](../test/harness/scenarios/counterexample.ts) | Extend the existing scenario: assert the result card really shows both counterexamples |

**Note**: older saved sessions do not have this field. Follow the existing convention and
say plainly that the old record has no such evidence — never let missing data read as
"nothing was wrong".

---

## 2. Experiment: independent answers first, then open critique (Sequential vs Independent-first)

**Not started, and it needs the user's agreement first** (same rule as experiment 4).
What follows is a pre-registration draft. Before it runs, the sample size and the exact
commit have to be filled in, and **this section must not be edited after seeing results**.

### Background

The discussion phase today is sequential: each member sees everything said before them.
That is the ordering that maximises anchoring. Experiment 3's post-hoc notes already show
its shadow: of the 10 roundtable runs that were not fully correct, **8 had result cards
saying "✓ review passed"** — reviewers echoing the executor. Cross-review was later moved
to a clean context precisely to cut that path, but **the discussion phase was never
changed**.

The literature points the same way: scaling homogeneous agents shows strong diminishing
returns and stronger models make more similar mistakes
([arXiv 2602.03794](https://arxiv.org/html/2602.03794v1)); under matched compute,
multi-agent debate generally fails to beat a single-agent baseline
([arXiv 2502.08788](https://arxiv.org/abs/2502.08788)).

### Hypotheses

- **H1**: Independent-first has a higher test pass rate than Sequential.
- **H2** (the more interesting one): Independent-first has *lower error correlation*
  than Sequential.

### Conditions

- **A (Sequential)**: today's behaviour. A answers → B sees A → C sees A+B → …
- **B (Independent-first)**: every member answers once in a clean context; nothing is
  revealed until all of them have answered, and only then does critique and verification
  begin.

### Metrics

- Primary: error correlation. Four members getting *different* things wrong versus all
  getting the *same* thing wrong. The exact definition has to be fixed before the run —
  suggested: mean pairwise Jaccard similarity of the failing-test sets across members on
  the same task. This is the metric that directly answers "how much shared thinking
  starts synchronising collective error".
- Secondary: test pass rate, fully-correct rate, wall-clock time, tokens.

### Known obstacles (solve these first, or the run measures something else)

1. `eval/ab.ts` only has two conditions (solo vs roundtable); a third is needed.
2. Error correlation needs **each member's own output**, and the flow currently only
   keeps the merged working directory. Either score each isolated directory separately
   (worktrees already exist) or have each member answer in a different file. This is the
   largest piece of work here — do it first.
3. Task selection is still a problem: all seven "write a single-file function from
   scratch" tasks hit the ceiling. The fix-existing-code tasks (`forth-fix`, `poker-fix`)
   have room, and error correlation is easier to define there because the hidden tests
   are fixed.

### Files to touch

| File | What |
| --- | --- |
| [src/orchestrator.ts](../src/orchestrator.ts) `discussPhase` | Add an independent first round: every member runs with `freshContext`, without the others' messages |
| [src/ipc-types.ts](../src/ipc-types.ts) | A discussion-mode setting; lineups have to remember it |
| [eval/ab.ts](../eval/ab.ts), [eval/stats.ts](../eval/stats.ts) | The third condition and the error-correlation computation |
| [eval/EXPERIMENTS.md](../eval/EXPERIMENTS.md) | Formally register the draft above before the run |

---

## 3. The README does not say that "roundtable beats solo" is unproven

**Today**: [eval/EXPERIMENTS.md](../eval/EXPERIMENTS.md) is unusually honest — whole
batches discarded when a bug was found, underpowered runs written down as such, post-hoc
analysis refused as a basis for conclusions. But the feature list in
[README.en.md](../README.en.md) reads as a series of claims, and a reader cannot see that
"several AIs reviewing each other produces better results" has never been demonstrated by
this project's own evaluation.

**The distinction to draw** (this is the point — it should not read as self-flagellation):

- Measured: same-model cross-review (experiments 3, 5, 6 — later voided because the
  repair round never received file tools) and small model executing with Claude Code
  reviewing (experiment 7: H3 not supported, primary metric −6.7 points, p = 0.631).
- **Never measured**: the product's actual flagship configuration — Claude Code and Codex
  at the same table.
- So the honest status is "**not demonstrated**", not "disproven". Those are very
  different, and the README currently says neither.

**Suggested placement**: the "Notes" section, or a short section of its own after the
feature list, linking to `eval/EXPERIMENTS.md`. Include the scope of what was just added:
the ratchet guarantees "no worse than before the task started", not "correct";
counterexamples guarantee "these specific bugs are gone", not "the requirements are met".

---

## 4. A compute-matched baseline (improvement 3)

A pre-existing flaw in the experiment design: the roundtable spends 1.5–3× the time and
tokens, but the control is "solo, one attempt". The correct control is **solo run N times
plus the same ratchet doing the selection**, with N chosen so token use matches.

The ratchet makes this possible for the first time — it *is* the selector. If the
roundtable cannot beat that baseline, the answer is clear; if it can, that is the real
selling point.

This shares infrastructure with item 2 (multi-condition support in `eval/ab.ts`), so plan
them together.
