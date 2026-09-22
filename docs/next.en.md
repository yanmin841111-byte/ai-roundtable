[繁體中文](next.md) | **English**

# What is next

Work that has been decided on but not done yet. It is written down so it can be picked
up from another machine, or after a gap — knowing _why_ something matters is as
important as knowing _which files to touch_, so both are here.

When an item is done, delete it from this file and record it in
[CHANGELOG.en.md](../CHANGELOG.en.md).

## After switching machines, check the environment still works

```bash
npm ci
npm run typecheck   # types
npm test            # unit tests
npm run e2e         # end-to-end
npm run harness:ui  # drives the real Electron app through UI scenarios, saves screenshots
```

`npm run harness:ui` is the slowest but the most important one: unit tests run under
plain node and cannot see that `process.execPath` is Electron inside the app. The first
48 runs of eval experiment 5 were discarded over exactly that class of difference.

---

## 1. Experiment: independent answers first, then open critique (Sequential vs Independent-first)

**Not started, and it needs the user's agreement first** (same rule as experiment 4).
What follows is a pre-registration draft. Before it runs, the sample size and the exact
commit have to be filled in, and **this section must not be edited after seeing results**.

### Background

Discussion remains sequential by default; an independent-first option is now implemented.
That is the ordering that maximises anchoring. Experiment 3's post-hoc notes already show
its shadow: of the 10 roundtable runs that were not fully correct, **8 had result cards
saying "✓ review passed"** — reviewers echoing the executor. Cross-review was later moved
to a clean context precisely to cut that path. Discussion isolation is now available,
but **its effect has not been measured**.

The literature points the same way: scaling homogeneous agents shows strong diminishing
returns and stronger models make more similar mistakes
([arXiv 2602.03794](https://arxiv.org/html/2602.03794v1)); under matched compute,
multi-agent debate generally fails to beat a single-agent baseline
([arXiv 2502.08788](https://arxiv.org/abs/2502.08788)).

### Hypotheses

- **H1**: Independent-first has a higher test pass rate than Sequential.
- **H2** (the more interesting one): Independent-first has _lower error correlation_
  than Sequential.

### Conditions

- **A (Sequential)**: today's behaviour. A answers → B sees A → C sees A+B → …
- **B (Independent-first)**: every member answers once in a clean context; nothing is
  revealed until all of them have answered, and only then does critique and verification
  begin.

### Metrics

- Primary: error correlation. Four members getting _different_ things wrong versus all
  getting the _same_ thing wrong. The exact definition has to be fixed before the run —
  suggested: mean pairwise Jaccard similarity of the failing-test sets across members on
  the same task. This is the metric that directly answers "how much shared thinking
  starts synchronising collective error".
- Secondary: test pass rate, fully-correct rate, wall-clock time, tokens.

### Infrastructure is ready; decisions still required

Discussion settings, lineups, multiple conditions, isolated candidate evidence, failing
test IDs and Jaccard are implemented. See the [evaluation guide](../eval/README.en.md#multiple-conditions-and-budgets).
No new formal experiment has run.

1. Obtain approval and fix the models, task set, repetitions, candidate count and public verification commands.
2. Compare `roundtable` / `independent-first` for product discussion, with matched round limits.
   Compare `sequential-candidates` / `independent-candidates` for per-candidate code failures:
   every candidate starts in a fresh app with original files, the sequential arm sees prior
   candidate files, and both arms use the same final critique/integration flow.
   **These are different operational definitions; candidate results do not directly prove
   the effect of the product's text-discussion policy.**
3. Freeze Jaccard rules: both-empty pairs are excluded and counted separately; incomplete apps
   are unavailable. Average pairs within a task, using complete runs, not pairs, as samples.
4. Calibrate tasks, especially `forth-fix` and `poker-fix`; basic tasks have ceiling effects.
5. Save `--dry-run` settings and protocol, enter the clean commit, sample size, primary
   contrast and decision rules in [EXPERIMENTS.md](../eval/EXPERIMENTS.md), then use `--approve-experiment`.

---

## 2. Calibrate the compute-matched baseline

`solo-budget` now supports repeated candidates and public ratchet selection. An approved,
separate calibration must still fix the token target, attempt cap, allowed mismatch and
meaningful public gates. Do not tune N using formal outcomes. Syntax-only ties retain the
original; hidden scores must never select the candidate.

The budget is checked after a candidate finishes, so it can overshoot by one candidate.
Reaching the attempt cap below target, or missing usage in any turn, does not establish
matching. Report actual totals and deviations; tokens across different models are not
equivalent FLOPs. Preregister these limitations and inclusion rules before running.
