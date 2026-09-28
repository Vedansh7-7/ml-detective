"""
Leaderboard scoring. See docs/SCORING.md for the reasoning.

    score = 1000 * Ev * Ec * T^0.4 * R^0.2 * K^0.4

    T  = 2*par_time / (par_time + time)                    solve time
    R  = 2*par_runs / (par_runs + runs)                    cell executions
    K  = 4 / (2 + cells/par_cells + runtime/par_runtime)   effort: cells + compute
    Ev = 0.8  ** wrong_verdicts
    Ec = 0.97 ** errored_cells

Every factor is 1.0 at par, so 1000 means "exactly par" and the ceiling
is 2000. Par comes from the case's level, can be overridden per case
(a "par" object in the secret file), and is replaced by the median of
real solves once a case has LEARN_AFTER of them.

Scores are always computed from the stored raw stats at read time, so
when a case's par is learned every solve of it is re-scored on the same
scale.
"""
from statistics import median

PAR_BY_LEVEL = {
    "easy":   {"time": 180, "runs": 6,  "cells": 4, "runtime": 3.0},
    "normal": {"time": 360, "runs": 10, "cells": 6, "runtime": 6.0},
    "hard":   {"time": 720, "runs": 16, "cells": 8, "runtime": 15.0},
}
LEARN_AFTER = 5

WRONG_VERDICT_KEEP = 0.8   # each wrong answer keeps 80% of the score
ERRORED_CELL_KEEP = 0.97   # each cell that raised an error keeps 97%

W_TIME, W_RUNS, W_EFFORT = 0.4, 0.2, 0.4


def _vs_par(par, value):
    """2*par / (par + value): 1.0 at par, ->2 as value -> 0, ->0 as it grows."""
    return 2 * par / (par + max(0.0, value))


def stats_of(entry):
    """The raw stats of a stored solve, with safe fallbacks for solves
    recorded before cells/runtime/errors were tracked."""
    runs = entry.get("steps", 0)
    return {
        "time": entry.get("elapsed_seconds", 0.0),
        "runs": runs,
        "cells": entry.get("cells", runs),
        "runtime": entry.get("runtime_seconds", 0.0),
        "wrong": max(0, entry.get("attempts", 1) - 1),
        "errored": entry.get("errored_cells", 0),
    }


def par_for(level, results_for_case=(), override=None):
    """Par for one case: level default < per-case override < learned median."""
    par = dict(PAR_BY_LEVEL.get(level, PAR_BY_LEVEL["normal"]))
    if override:
        par.update({k: v for k, v in override.items() if k in par})
    if len(results_for_case) >= LEARN_AFTER:
        stats = [stats_of(r) for r in results_for_case]
        for key in par:
            learned = median(s[key] for s in stats)
            if learned > 0:
                par[key] = learned
    return par


def score(stats, par):
    t = _vs_par(par["time"], stats["time"])
    r = _vs_par(par["runs"], stats["runs"])
    k = 4 / (2 + stats["cells"] / par["cells"] + stats["runtime"] / par["runtime"])
    ev = WRONG_VERDICT_KEEP ** stats["wrong"]
    ec = ERRORED_CELL_KEEP ** stats["errored"]
    return round(1000 * ev * ec * t ** W_TIME * r ** W_RUNS * k ** W_EFFORT)


def rank(results, par_lookup):
    """Score every solve, keep each player's best per case, best first.

    par_lookup(dataset_id, level, solves_of_that_case) -> par dict."""
    by_case = {}
    for r in results:
        by_case.setdefault(r["dataset_id"], []).append(r)

    best = {}
    for case_id, solves in by_case.items():
        par = par_lookup(case_id, solves[0].get("level"), solves)
        for r in solves:
            scored = dict(r, score=score(stats_of(r), par))
            key = (r.get("player"), case_id)
            if key not in best or scored["score"] > best[key]["score"]:
                best[key] = scored
    return sorted(best.values(), key=lambda r: (-r["score"], r.get("timestamp", 0)))
