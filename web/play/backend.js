// The browser "server". app.js calls api(path, body) exactly as it did against
// the Flask app; here each path is answered in the browser:
//   - cells always run in the Python worker (engine.js), on the player's device
//   - ONLINE (normal): a guest Supabase session; verdicts are checked and
//     solves recorded by the `game` function; boards are shared (online.js)
//   - LOCAL (fallback when the backend can't be reached): verdicts are checked
//     against hashed keys and solves stay in this browser
import { Engine } from "./engine.js";
import { parFor, rank, score, statsOf } from "./scoring.js";

const CASES = "../cases";
const STORE_SOLVES = "mld.solves.v1";
const STORE_NAME = "mld.name";
const STORE_FEEDBACK = "mld.feedback.v1";
const CONNECT_TIMEOUT_MS = 8000;

const AVAILABLE_PACKAGES = ["pandas", "numpy", "matplotlib", "seaborn", "scikit-learn", "scipy"];

// ---------- small storage helpers (private windows can throw) ----------
function readJSON(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
}
function writeJSON(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage unavailable */ }
}

// ---------- online or local ----------
let online = null;          // the online.js module once connected
let offlineReason = null;
const ready = (async () => {
  try {
    const mod = await import("./online.js");
    await Promise.race([
      mod.connect(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("backend timed out")), CONNECT_TIMEOUT_MS)),
    ]);
    online = mod;
  } catch (err) {
    offlineReason = String(err && err.message || err);
    console.warn("ML Detective: playing offline --", offlineReason);
  }
})();
export const isOnline = () => !!online;
export const whenReady = () => ready;

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
function newGame(item) {
  return {
    item, level: item.level, verdict: null, gameId: null, csv: null,
    startTime: Date.now(), steps: 0, attempts: 0, solved: false,
    cells: new Set(), errored: new Set(), runtime: 0,
    notebook: new Map(),      // cellId -> latest code run in that cell (for Scout)
  };
}

function rankedLocal() {
  return rank(readJSON(STORE_SOLVES, []), (id, level, forCase) => parFor(level, forCase));
}
async function rankedOnline(filter) {
  const rows = await online.boardRows(filter);
  return rank(rows, (id, level, forCase) => parFor(level, forCase, forCase[0].par));
}

// ---------- endpoints ----------
const routes = {
  "/api/config": async () => {
    await ready;
    const name = (online && await online.myName()) || readJSON(STORE_NAME, null);
    return { lan: false, needs_code: false, local: !online, offline_reason: offlineReason, name };
  },

  "/api/join": async ({ name }) => {
    const clean = String(name || "").replace(/\s+/g, " ").trim().slice(0, 24);
    if (!clean) return { error: "pick a detective name first" };
    writeJSON(STORE_NAME, clean);
    await ready;
    if (online) {
      await online.setName(clean);
      online.joinLobby(clean);
    }
    return { ok: true, name: clean };
  },

  "/api/levels": async () => ({ inbox: [], ...(await caseIndex()) }),

  "/api/leaderboard": async () => (online ? rankedOnline() : rankedLocal()),

  "/api/live": async () => (online
    ? { online: online.online(), results: await rankedOnline(), now: Date.now() / 1000 }
    : { online: 1, results: rankedLocal(), now: Date.now() / 1000 }),

  "/api/start": async ({ story_id, room_code }) => {
    const item = await findCase(story_id);
    if (!item) return { error: `unknown story '${story_id}'` };
    const csv = await fetch(`${CASES}/${story_id}/data.csv`).then((r) => r.text());
    const next = newGame(item);
    next.csv = csv;
    await ready;
    if (online) {
      const started = await online.callGame({ action: "start", case_id: story_id, room_code });
      if (started.error) return { error: started.error };
      next.gameId = started.game_id;
    } else {
      next.verdict = await fetch(`${CASES}/${story_id}/verdict.json`).then((r) => r.json());
    }
    await engine.ready;
    const { shape } = await engine.call("start", { csv });
    game = next;
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
    game.notebook.set(cellId, code);
    return { ...out, steps: game.steps };
  },

  "/api/submit": async ({ answer, share }) => {
    if (!game) return { error: "no active game -- open a case first" };
    if (game.solved) return { error: "already solved -- start a new case" };
    const text = String(answer || "").trim();
    return online ? submitOnline(text, share) : submitLocal(text);
  },

  // the cases *this* player has closed (for SOLVED stamps and Scout access)
  "/api/mine": async () => {
    await ready;
    if (online) return { solved: await online.mySolvedCases() };
    return { solved: [...new Set(readJSON(STORE_SOLVES, []).map((s) => s.dataset_id))] };
  },

  "/api/scout": async ({ case_id }) => {
    await ready;
    if (!online) return { error: "Scout needs the online archive -- you're playing offline right now." };
    // re-score on the same (possibly learned) par the board uses, so the numbers match
    const [solves, forCase] = await Promise.all([online.scout(case_id), online.boardRows({ caseIds: [case_id] })]);
    if (!forCase.length) return { solves };
    const par = parFor(forCase[0].level, forCase, forCase[0].par);
    const rescored = solves.map((s) => ({ ...s, score: score(statsOf(s), par) }));
    rescored.sort((x, y) => y.score - x.score);
    return { solves: rescored };
  },

  "/api/feedback": async ({ text, rating }) => {
    const t = String(text || "").trim().slice(0, 4000);
    if (!t && rating == null) return { error: "write something first" };
    const row = { case_id: game && game.item.story.id, rating, text: t };
    if (online) {
      await online.sendFeedback(row);
    } else {
      const all = readJSON(STORE_FEEDBACK, []);
      all.push({ ...row, player: readJSON(STORE_NAME, null), timestamp: new Date().toISOString() });
      writeJSON(STORE_FEEDBACK, all);
    }
    return { ok: true };
  },
};

async function submitOnline(text, share) {
  const res = await online.callGame({
    action: "verdict",
    game_id: game.gameId,
    answer: text,
    share: share !== false,
    notebook: [...game.notebook.values()],
    stats: {
      steps: game.steps,
      cells: game.cells.size,
      errored_cells: game.errored.size,
      runtime_seconds: Math.round(game.runtime * 1000) / 1000,
    },
  });
  if (res.correct) game.solved = true;
  if (!res.correct && typeof res.attempts === "number") game.attempts = res.attempts;
  return res;
}

async function submitLocal(text) {
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
    return {
      correct: true,
      elapsed_seconds: elapsed,
      steps: game.steps,
      attempts: entry.attempts,
      score: score(statsOf(entry), parFor(entry.level, forCase, game.verdict.par)),
      explanation: decode(game.verdict.explanation),
    };
  }
  game.attempts += 1;
  const hints = decode(game.verdict.hints);
  return { correct: false, attempts: game.attempts, hint: hints[Math.min(game.attempts, hints.length) - 1] };
}

export async function api(path, body) {
  const route = routes[path];
  if (!route) return { error: `unknown endpoint ${path}` };
  try {
    return await route(body || {});
  } catch (err) {
    return { error: String(err && err.message || err) };
  }
}
