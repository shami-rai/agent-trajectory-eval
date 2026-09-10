# Agent trajectory eval

Scoring the path an agent took rather than just its final answer: redundant calls, recovery from errors, dead ends. Final-answer accuracy hides all of it.

Part of the learn → execute → report loop at
[shamirai.ai](https://shamirai.ai/e/agent-trajectory-eval/). The writeup lives there.

## What this is

A plain-code scorer for agent trajectories, measured against hand labels. The agent is
loop-engineering's: Claude answering one question about a synthetic fleet of 400 medical devices
through three narrow tools (count, rank by one stored field with a 10-row cap, fetch one device).
A corpus of 24 runs with different paths (Opus 5 at low, medium and high effort, parallel and
serial tool calls, a Haiku 4.5 arm, and sabotaged environments) was labelled by hand for ten
trajectory properties before the scorer was run on it. The result is a per-property split: what
code detects reliably, what it detects only through heuristics that misfire, and what it cannot
detect.

## Running it

```bash
npm install
echo "ANTHROPIC_API_KEY=..." > .env    # gitignored

npm run agent -- --id x1 --env normal --effort low --out runs/scratch.jsonl   # one run
npm run corpus                         # the 24-run corpus, sequential, resumable
npm run render -- runs/corpus.jsonl    # plain-text traces for reading (runs/rendered/)
npm run score -- runs/corpus.jsonl --out results/scores-corpus.json
npm run agreement                      # scorer (and judge, if present) vs labels/labels.json
npm run summary -- runs/corpus.jsonl   # correct answer vs justified path, per run and per arm
node scripts/posthoc-numbers.mjs       # the post-hoc numbers check described below
npm run judge -- runs/corpus.jsonl     # optional LLM-judge comparison
npm run spend                          # running API spend over runs/*.jsonl
```

Scoring, rendering, agreement and summary are free and deterministic. Agent runs and the judge
call the API.

## Design

- `src/rig/`: the fleet, tools, task and a hand-written agent loop, carried over from
  loop-engineering. `agent.mjs` also records the model's thinking summaries per turn, because at
  low effort the reasoning between tool calls is otherwise invisible. `envs.mjs` defines the
  environments: `normal`, `hidden` (AV3-007 removed from the world, so the answer that world
  supports is IL7-032, the device the lazy path lands on), `flaky` (seeded transient 503s on
  roughly 30% of calls), `misleading` (the tool description claims downtime is already normalised
  per 100 hours), `capped` (3 turns).
- `src/eval/properties.mjs`: the ten properties, each defined twice, once for a human reader and
  once as code.
- `src/eval/oracle.mjs`: a model of what the tools mean (a top-k result caps every row it did not
  return; a total that equals the identified devices exhausts a range). From that it bounds the
  rate every seen device, and a hypothetical unseen device, could have, and decides whether the
  observations prove an answer, from which turn, and which calls could be dropped.
- `src/eval/score.mjs`: the scorer. No model.
- `scripts/judge.mjs`: a small LLM-as-judge comparison (Opus 5, low effort) on the same rendered
  traces and definitions. Written, not run (see below).
- `labels/labels.json`: the hand labels, with a note per run. The scorer was frozen and committed
  before the corpus existed, and was not run on any corpus run until the labels were committed.
- `runs/`: every run record (JSONL). `corpus.jsonl` is the labelled corpus; `dev.jsonl` (one pilot
  run) and `legacy.jsonl` (loop-engineering's two traces, re-executed to recover truncated
  results) are the dev set the scorer was tuned on. `results/`: scorer output and agreement.

## Results

24 corpus runs, hand-labelled before the frozen scorer (v1, commit `30466e4`) was run on them
(labels committed in `649ea0c`). Agreement between scorer and hand labels, per property
(`results/agreement.json`, every disagreement listed in `results/agreement.txt`):

| property | unit | agreement | what the counts show | verdict |
|---|---|---|---|---|
| batched | run | 24/24 | 17 runs batched | reliable, trivially |
| redundant | call | 324/324 | no repeated call anywhere, by hand or by code | untested: no positives |
| unused | call | 246/298 (83%) | hand 13, scorer 61; only 11 of the scorer's 61 are right | heuristic, misfires |
| error_recovered | error | 25/26 | 26 tool errors; the miss is a different call to the same tool counted as recovery | reliable, one known misfire |
| grounded | run | 23/23 | no run named a device it had not seen | reliable, never violated |
| numbers_supported | run | 16/23 (70%) | every scorer flag came from a model name ("InfusaLine 700"), firmware or "~9%"; the 4 real problems (a count written as a word, 3 misread units) caught for the right reason: 0 | heuristic, blind to the real errors |
| shortcut | run | 24/24 | 7 shortcut runs | reliable |
| justified | run | 24/24 | 6 justified | reliable, but only with a model of the tools (the oracle) |
| determinable_turn | run | 24/24 exact | 6 runs ever determinable | reliable, same caveat |
| bound_reasoning | run | 18/24 (75%) | 13 by hand; scorer missed 5, 1 false hit ("the 99 ceiling") | heuristic, partial |

The agreement on `justified` and `determinable_turn` measures that the oracle implements careful
bound reasoning correctly; the hand labels were produced by doing that reasoning by hand, so they
share a method with the oracle. A post-hoc fix for the model-name bug (`scripts/posthoc-numbers.mjs`)
raises `numbers_supported` to 20/23 while catching none of the four real problems.

What final-answer grading would have missed (`npm run summary`):

| | runs | correct answer | justified path | correct but unjustified |
|---|---|---|---|---|
| Opus 5 low, normal | 5 | 5 | 0 | 5 |
| Opus 5 medium, normal | 2 | 2 | 1 | 1 |
| Opus 5 high, normal | 3 | 3 | 2 | 1 |
| Haiku 4.5, normal | 3 | 0 | 0 | 0 |
| sabotaged environments (Opus and Haiku) | 11 | 6 | 3 | 3 |
| all | 24 | 16 | 6 | 10 |

Runs that ever became determinable made 0 or 1 calls after that point; 18 of 24 never did.

The LLM-judge comparison (`scripts/judge.mjs`) did not run: every call returned HTTP 400, credit
balance too low on the shared API key (`runs/judge.log`), including a retry after scoring, at no
cost. Total API spend: $1.963 (corpus $1.898, one pilot run $0.065).
