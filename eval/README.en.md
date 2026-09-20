[繁體中文](README.md) | **English**

# Review-quality evaluation

In the divide flow every piece of work is reviewed by another member. This evaluation measures that guarantee: **with a real model as the reviewer, does it catch mistakes, and does it avoid false alarms?**

The executor is always a script (it hands in exactly the same files and report every time) and only the reviewer is the model under test, so the score reflects reviewing alone, not execution. The reports all sound confident: a reviewer that only reads the report will always approve, and only one that looks at the files can catch the problem.

## Tasks

| Task | Question it answers | Should |
| --- | --- | --- |
| `obvious-bug` | The report says it is correct, but the file has `a - b` instead of `a + b`. Is it caught? | Flag issues |
| `correct` | Control: is the correct version wrongly flagged? | Approve |
| `suspicious-but-correct` | Code that looks odd (`a - -b`, bit operations) but is entirely correct. Is it wrongly flagged? | Approve |
| `bug-beyond-inline-limit` | Of 8 files, the wrong one falls outside the limit of files whose content is attached. Does the reviewer read it, or at least say it could not, rather than approve? | Flag issues |
| `cross-file` | The rename is right, but a caller was not updated (the bug is outside the change). Does the reviewer look beyond the change? | Flag issues |
| `analysis-only` | Analysis only, no files changed, and the conclusion is wrong. Does the reviewer check the source? | Flag issues |

The tasks live in [cases.ts](cases.ts). A new task should answer a specific question, not just add another "is there a bug".

## Running it

A real model is required. The default is `qwen3.8:27b-mlx` on local Ollama: run `ollama serve` and set Ollama up once in the app with "Connect a local model".

```bash
npm run eval                            # 3 runs per task
npm run eval -- --runs 10 --save        # 10 runs per task, result written to eval/results/
npm run eval -- --cases cross-file      # only some tasks (comma-separated)
EVAL_MODEL=gemma3:27b npm run eval      # another Ollama model
EVAL_VERBOSE=1 npm run eval             # print the reviews in the terminal (never written to the result file)
```

To use another CLI or API as the reviewer:

| Variable | Purpose | Default |
| --- | --- | --- |
| `EVAL_CLI` | The reviewer's CLI or extension id | `ollama` |
| `EVAL_MODEL` | The model; empty means the CLI's default | `qwen3.8:27b-mlx` |
| `EVAL_ADAPTER` | An installed extension to copy into the test environment (file name without `.json`); set it to an empty string for built-in CLIs (`claude`, `codex`, `cursor`) | `ollama-api` |

For example `EVAL_CLI=claude EVAL_MODEL= EVAL_ADAPTER= npm run eval`. **Paid CLIs and APIs cost money on every run**: 6 tasks × 10 runs is 60 reviews, so choose the count first.

Every run uses a fresh app and a fresh throwaway working folder; your settings, members and this repo are never touched. A run takes roughly 1–4 minutes depending on the model.

## Reading the result

The runner prints its summary in Traditional Chinese, like the other test tools in this repo (判對 = correct, 失敗不計 = failed and not scored, 有讀檔 = read the files, 合計 = total):

```
obvious-bug                10/10 判對 · 有讀檔 10 次
suspicious-but-correct     6/10 判對 · 有讀檔 9 次
...
合計                       47/60
```

- **Correct**: a task that should be flagged was not approved, and a task that should pass was approved. The verdict uses the product's own rule (the `[NO_ISSUES]` marker), the same one the flow uses to decide whether a repair round runs.
- **Failures are not scored**: a review turn that failed (timeout, endpoint error, no output) counts as neither right nor wrong and is listed separately. Many failures mean the setup or the model has a problem and the score is not reliable.
- **Read files**: whether the reviewer opened the task's files itself in that turn (a CLI reading them, or an API member calling `read_file`). Content attached to the prompt does not count: a review attaches the content of up to 6 changed files, and those can be seen without reading. So a correct verdict without reading, on a file that was not attached (the 8th file in `bug-beyond-inline-limit`, the caller in `cross-file`, the source in `analysis-only`), is usually a lucky guess.

Model output varies, so **one run is only a sample**. When comparing two models or two versions, run each task at least 10 times, and do not run two evaluations at once against the same local Ollama; they slow each other down.

## Solo vs roundtable

The evaluation above only measures whether a reviewer catches mistakes. This one asks whether the whole thing is worth it: **with the same model on the same task, does working alone, or working and then being reviewed and fixing the findings, get it right more often, and how long does each take?**

```bash
npm run eval:ab                          # 5 tasks × 2 conditions × 3 runs
npm run eval:ab -- --runs 5 --tasks csv  # only some tasks
EVAL_REVIEWER_CLI=claude npm run eval:ab # use another model as the roundtable's reviewer (here Claude Code, which uses your subscription)
```

A model reviewing its own work tends to share its blind spots. `EVAL_REVIEWER_CLI`, `EVAL_REVIEWER_MODEL` and `EVAL_REVIEWER_ADAPTER` switch the roundtable's reviewer to another model (same meaning as the `EVAL_*` variables above), to measure whether a second pair of eyes helps.

- Both run in the real app. The lead is a script that hands the whole task to the same executor, so the division of work is identical.
  - **Solo**: the review is a script that always approves, which amounts to no review.
  - **Roundtable**: one more member with the same model joins the discussion and really reviews; if it finds problems, a repair round runs.
- Every task has **hidden tests** the model never sees, used only for scoring afterwards. Each task ships a reference solution (must pass everything) and a common wrong solution (must fail at least one test), checked by `npm test`, so the tests themselves are known to be right.
- A failed execution turn (for example, too many tool-call round trips) **is still scored**: whatever the files contain is what you would have got by handing it the task. Only runs where the app itself did not finish are left out.
- The model's code is tested in a child process on your machine, with a timeout.

| Task | What it tests |
| --- | --- |
| `semver` | Many spec details (pre-release precedence rules) |
| `intervals` | Touching intervals must merge; the input must not change |
| `duration` | More inputs to reject than to accept |
| `cart-bugs` | The user reports one symptom; the file has three bugs |
| `csv` | Quotes, escaped quotes, empty fields |

## Sharing scores

Scores for the model you use are welcome as a PR: run `npm run eval -- --runs 10 --save` and send the one file it creates in `eval/results/`.

A result file holds **only numbers**: the date, the app version and commit, the reviewer's CLI and model, and per task how many runs, how many correct, how many failed and how many read the files. It never contains a review, a prompt or a local path, so it is safe to share. The format is defined in [score.ts](score.ts). A commit ending in `-dirty` means the working tree had uncommitted changes during the run, so the score is not exactly that commit's; run on a clean commit for scores you share.
