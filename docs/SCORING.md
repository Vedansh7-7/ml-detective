# Scoring

The leaderboard ranks solves by a single score. It rewards finding the fault quickly, with few runs, a lean notebook and no guessing.

```
score = 1000 × Ev × Ec × T^0.4 × R^0.2 × K^0.4

T  = 2·par_time / (par_time + time)                    how fast you solved it
R  = 2·par_runs / (par_runs + runs)                    how many times you ran a cell
K  = 4 / (2 + cells/par_cells + runtime/par_runtime)   effort: cells used + compute time
Ev = 0.8  ^ wrong_verdicts                             each wrong answer keeps 80%
Ec = 0.97 ^ errored_cells                              each cell that raised an error keeps 97%
```

**1000 means exactly par. The ceiling is 2000.** Every factor is 1.0 at par and moves toward 2 as you beat it. Cells and compute time are *added* in the effort term, so a notebook that is heavy on one and light on the other isn't punished twice.

## What gets measured

| Stat | Meaning |
|---|---|
| time | seconds from opening the case to the correct verdict |
| runs | cell executions, re-runs included |
| cells | distinct cells you ran |
| runtime | total seconds your cells spent executing |
| wrong verdicts | answers submitted before the right one |
| errored cells | distinct cells that raised an exception at least once |

## Par

Each case has a par for time, runs, cells and runtime:

1. **Level default** (below).
2. **Per-case override**: a `"par"` object in the case's secret file, e.g. `{"time": 240, "runs": 8}`.
3. **Learned**: once a case has 5 solves, par becomes the median of those solves.

| Level | time | runs | cells | runtime |
|---|---|---|---|---|
| easy | 3 min | 6 | 4 | 3 s |
| normal | 6 min | 10 | 6 | 6 s |
| hard | 12 min | 16 | 8 | 15 s |

Scores are computed from the stored raw stats when the board is read. When a case's par is learned, every solve of that case is re-scored on the same scale.

## The board

Each player's **best** score per case, highest first. Replaying a case and doing worse never lowers your entry.

## Worked examples (easy case, default par)

| Player | time | runs | cells | runtime | wrong | errored | score |
|---|---|---|---|---|---|---|---|
| Careful | 2m00s | 5 | 4 | 1.2 s | 0 | 0 | **1168** |
| Fast but guessy | 1m30s | 3 | 2 | 0.5 s | 2 | 0 | **894** |
| Heavy model | 3m20s | 4 | 2 | 12 s | 0 | 0 | **836** |
| Messy | 2m30s | 14 | 9 | 4 s | 0 | 4 | **724** |

## Known limits

- Runtime depends on the machine running the code. In LAN mode everything runs on the host, so it's fair. If the game moves to in-browser Python, a slower laptop will cost a little, which is why the effort term is weighted rather than dominant.
- The constants (weights, 0.8, 0.97, level pars) are starting values. Tune them from real play data.
