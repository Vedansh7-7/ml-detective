// The browser "server". app.js calls api(path, body) exactly as it did against
// the Flask app; here each path is answered locally:
//   - cases come from the exported files in ../cases/
//   - cells run in the Python worker (engine.js)
//   - verdicts are checked against hashed keys, scores use scoring.js
//   - solves are stored per browser (the shared online boards replace
//     this store once the backend is connected)
import { Engine } from "./engine.js";
import { parFor, rank, score, statsOf } from "./scoring.js";

const CASES = "../cases";
const STORE_SOLVES = "mld.solves.v1";
const STORE_NAME = "mld.name";
const STORE_FEEDBACK = "mld.feedback.v1";

const AVAILABLE_PACKAGES = ["pandas", "numpy", "matplotlib", "seaborn", "scikit-learn", "scipy"];

// ---------- small storage helpers (private windows can throw) ----------
function readJSON(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
}
function writeJSON(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage unavailable */ }
}

// ---------- case files ----------
let indexPromise = null;
function caseIndex() {
  indexPromise ??= fetch(`${CASES}/index.json`).then((r) => r.json());
  return indexPromise;
}
async function findCase(id) {
  const { levels } = await caseIndex();
  for (const { level, stories } of levels) {
    const item = stories.find((s) => s.story.id === id);
    if (item) return { level, ...item };
  }
  return null;
}
const decode = (b64) => JSON.parse(decodeURIComponent(escape(atob(b64))));

// ---------- python ----------
const statusListeners = new Set();
let engineStatus = { state: "loading", info: null };
export const engine = new Engine((state, info) => {
  engineStatus = { state, info };
  statusListeners.forEach((fn) => fn(engineStatus));
});
export function onEngineStatus(fn) {
  statusListeners.add(fn);
  fn(engineStatus);
}

// ---------- the current game ----------
let game = null;
function newGame(item, verdict) {
  return {
    item, verdict, level: item.level,
    startTime: Date.now(), steps: 0, attempts: 0, solved: false,
    cells: new Set(), errored: new Set(), runtime: 0,
  };
}

function rankedSolves() {
  const solves = readJSON(STORE_SOLVES, []);
  return rank(solves, (id, level, forCase) => parFor(level, forCase));
}

// ---------- endpoints ----------
const routes = {
  "/api/config": async () => ({ lan: false, needs_code: false, local: true, name: readJSON(STORE_NAME, null) }),

  "/api/join": async ({ name }) => {
    const clean = String(name || "").replace(/\s+/g, " ").trim().slice(0, 24);
    if (!clean) return { error: "pick a detective name first" };
    writeJSON(STORE_NAME, clean);
    return { ok: true, name: clean };
  },

  "/api/levels": async () => ({ inbox: [], ...(await caseIndex()) }),

  "/api/leaderboard": async () => rankedSolves(),

  "/api/live": async () => ({ online: 1, results: rankedSolves(), now: Date.now() / 1000 }),

  "/api/start": async ({ story_id }) => {
    const item = await findCase(story_id);
    if (!item) return { error: `unknown story '${story_id}'` };
    const [csv, verdict] = await Promise.all([
      fetch(`${CASES}/${story_id}/data.csv`).then((r) => r.text()),
      fetch(`${CASES}/${story_id}/verdict.json`).then((r) => r.json()),
    ]);
    await engine.ready;
    const { shape } = await engine.call("start", { csv });
    game = newGame(item, verdict);
    game.csv = csv;
    return { meta: item.meta, story: item.story, shape, available_packages: AVAILABLE_PACKAGES };
  },

  // stop a runaway cell: restart Python and reload the case. The notebook's
  // variables are gone, but the game (and its scoring stats) carries on.
  "/api/restart": async () => {
    await engine.restart();
    if (game) await engine.call("start", { csv: game.csv });
    return { ok: true };
  },

  "/api/run": async ({ code, cell_id }) => {
    if (!game) return { error: "no active game -- open a case first" };
    game.steps += 1;
    const cellId = String(cell_id || `run-${game.steps}`).slice(0, 40);
    let out;
    try {
      out = await engine.call("run", { code, cellName: `<cell ${game.steps}>` });
    } catch (err) {
      if (!/restarted/.test(err.message)) throw err;
      out = { stdout: "", result: null, images: [], runtime: 0,
              error: "Stopped. Python was restarted, so earlier imports and variables are gone: " +
                     "re-run the cells you need (df is loaded again)." };
    }
    game.runtime += out.runtime || 0;
    game.cells.add(cellId);
    if (out.error) game.errored.add(cellId);
    return { ...out, steps: game.steps };
  },

  "/api/submit": async ({ answer }) => {
    if (!game) return { error: "no active game -- open a case first" };
    if (game.solved) return { error: "already solved -- start a new case" };
    const text = String(answer || "").trim();
    const correct = await engine.call("check", { text, keys: game.verdict.keys });

    if (correct) {
      game.solved = true;
      const elapsed = Math.round((Date.now() - game.startTime) / 100) / 10;
      const entry = {
        player: readJSON(STORE_NAME, "detective"),
        level: game.level,
        dataset_id: game.item.story.id,
        story_title: game.item.story.title,
        elapsed_seconds: elapsed,
        steps: game.steps,
        attempts: game.attempts + 1,
        cells: game.cells.size,
        errored_cells: game.errored.size,
        runtime_seconds: Math.round(game.runtime * 1000) / 1000,
        timestamp: Date.now() / 1000,
      };
      const solves = readJSON(STORE_SOLVES, []);
      solves.push(entry);
      writeJSON(STORE_SOLVES, solves);
      const forCase = solves.filter((s) => s.dataset_id === entry.dataset_id);
      const par = parFor(entry.level, forCase, game.verdict.par);
      return {
        correct: true,
        elapsed_seconds: elapsed,
        steps: game.steps,
        attempts: entry.attempts,
        score: score(statsOf(entry), par),
        explanation: decode(game.verdict.explanation),
      };
    }

    game.attempts += 1;
    const hints = decode(game.verdict.hints);
    return { correct: false, attempts: game.attempts, hint: hints[Math.min(game.attempts, hints.length) - 1] };
  },

  "/api/feedback": async ({ text, rating }) => {
    const t = String(text || "").trim().slice(0, 4000);
    if (!t && rating == null) return { error: "write something first" };
    const all = readJSON(STORE_FEEDBACK, []);
    all.push({ player: readJSON(STORE_NAME, null), rating, text: t,
               case: game && game.item.story.id, timestamp: new Date().toISOString() });
    writeJSON(STORE_FEEDBACK, all);
    return { ok: true };
  },
};

export async function api(path, body) {
  const route = routes[path];
  if (!route) return { error: `unknown endpoint ${path}` };
  try {
    return await route(body || {});
  } catch (err) {
    return { error: String(err && err.message || err) };
  }
}
