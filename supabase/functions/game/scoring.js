// Leaderboard scoring -- a line-for-line port of scoring.py (see docs/SCORING.md).
// Plain ES module: used by the browser board and by the backend function.
//
//   score = 1000 * Ev * Ec * T^0.4 * R^0.2 * K^0.4

export const PAR_BY_LEVEL = {
  easy:   { time: 180, runs: 6,  cells: 4, runtime: 3.0 },
  normal: { time: 360, runs: 10, cells: 6, runtime: 6.0 },
  hard:   { time: 720, runs: 16, cells: 8, runtime: 15.0 },
};
export const LEARN_AFTER = 5;

const WRONG_VERDICT_KEEP = 0.8;
const ERRORED_CELL_KEEP = 0.97;
const W_TIME = 0.4, W_RUNS = 0.2, W_EFFORT = 0.4;

const vsPar = (par, value) => (2 * par) / (par + Math.max(0, value));

// Python's round(): half to even
function roundHalfEven(x) {
  const f = Math.floor(x), diff = x - f;
  if (Math.abs(diff - 0.5) < 1e-9) return f % 2 === 0 ? f : f + 1;
  return Math.round(x);
}

function median(values) {
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function statsOf(entry) {
  const runs = entry.steps ?? 0;
  return {
    time: entry.elapsed_seconds ?? 0,
    runs,
    cells: entry.cells ?? runs,
    runtime: entry.runtime_seconds ?? 0,
    wrong: Math.max(0, (entry.attempts ?? 1) - 1),
    errored: entry.errored_cells ?? 0,
  };
}

export function parFor(level, resultsForCase = [], override = null) {
  const par = { ...(PAR_BY_LEVEL[level] || PAR_BY_LEVEL.normal) };
  if (override) for (const k of Object.keys(par)) if (k in override) par[k] = override[k];
  if (resultsForCase.length >= LEARN_AFTER) {
    const stats = resultsForCase.map(statsOf);
    for (const k of Object.keys(par)) {
      const learned = median(stats.map((s) => s[k]));
      if (learned > 0) par[k] = learned;
    }
  }
  return par;
}

export function score(stats, par) {
  const t = vsPar(par.time, stats.time);
  const r = vsPar(par.runs, stats.runs);
  const k = 4 / (2 + stats.cells / par.cells + stats.runtime / par.runtime);
  const ev = WRONG_VERDICT_KEEP ** stats.wrong;
  const ec = ERRORED_CELL_KEEP ** stats.errored;
  return roundHalfEven(1000 * ev * ec * t ** W_TIME * r ** W_RUNS * k ** W_EFFORT);
}

// each player's best score per case, best first
export function rank(results, parLookup) {
  const byCase = new Map();
  for (const r of results) {
    if (!byCase.has(r.dataset_id)) byCase.set(r.dataset_id, []);
    byCase.get(r.dataset_id).push(r);
  }
  const best = new Map();
  for (const [caseId, solves] of byCase) {
    const par = parLookup(caseId, solves[0].level, solves);
    for (const r of solves) {
      const scored = { ...r, score: score(statsOf(r), par) };
      const key = `${r.player}\u0000${caseId}`;
      if (!best.has(key) || scored.score > best.get(key).score) best.set(key, scored);
    }
  }
  return [...best.values()].sort((a, b) => b.score - a.score || (a.timestamp ?? 0) - (b.timestamp ?? 0));
}
