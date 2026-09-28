// ML Detective -- browser version. Same UI as the desktop app; api() is
// answered in the browser by backend.js (Python runs in a Web Worker).
//
// Flow:  #splash  --fade-->  #hero  --travel-->  #story-intro  --travel-->  #ide
//        (brutalist)         (brutalist)         (story palette)           (story palette)
import { api, onEngineStatus } from "./backend.js";

const $ = (sel, root = document) => root.querySelector(sel);

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
}

// "Python: loading / ready" pills (hero + notebook bar)
let pythonReady = false;
onEngineStatus(({ state, info }) => {
  pythonReady = state === "ready";
  document.querySelectorAll(".py-pill").forEach((pill) => {
    pill.dataset.state = state;
    pill.textContent = state === "ready" ? `PYTHON ${info.python} · READY`
      : state === "error" ? "PYTHON FAILED TO LOAD — RELOAD" : "PYTHON · WARMING UP…";
  });
});

const LEVEL_COPY = {
  easy:   { num: "01", blurb: "One value that can't be true. Summary statistics will get you far." },
  normal: { num: "02", blurb: "One feature that shouldn't exist. Think about what a model is allowed to know." },
  hard:   { num: "03", blurb: "One pattern spread across columns. Looking at one column at a time won't be enough." },
};

const state = {
  story: null,       // public story JSON of the case in play
  meta: null,        // public meta JSON of the case in play
  timerHandle: null,
  startedAt: null,
  solved: false,
};

// ---------------------------------------------------------------------------
// screens + transitions
// ---------------------------------------------------------------------------
function go(toId, mode = "fade") {
  const from = document.querySelector(".screen.active:not(.leaving)");
  const to = document.getElementById(toId);
  if (from === to) return;

  if (from) {
    from.classList.add(mode, "leaving");
    setTimeout(() => from.classList.remove("active", "leaving", "fade", "travel"), 700);
  }
  to.classList.add("active", mode, "entering");
  // two frames: let the browser paint the "entering" start state first
  requestAnimationFrame(() => requestAnimationFrame(() => to.classList.remove("entering")));
  setTimeout(() => to.classList.remove(mode), 750);
}

function applyTheme(p) {
  const root = document.documentElement.style;
  ["bg", "surface", "ink", "muted", "accent", "accent2", "note"].forEach((k) =>
    root.setProperty(`--s-${k}`, p[k]));
  root.setProperty("--s-note-ink", p.note_ink);
  root.setProperty("--s-line", p.muted + "55");
  document.documentElement.dataset.storyDark = p.dark ? "1" : "0";
}

const doodleCache = {};
function loadDoodle(file) {
  // weekly/uploaded cases carry their (validated) SVG inline instead of a file name
  if (file && file.trimStart().startsWith("<svg")) return Promise.resolve(file);
  if (!doodleCache[file]) {
    doodleCache[file] = fetch(`doodles/${file}`).then((r) => r.text());
  }
  return doodleCache[file];
}
async function paintDoodle(container, file) {
  container.innerHTML = await loadDoodle(file);  // our own local SVG files
}

function renderNarrative(container, paragraphs) {
  container.innerHTML = "";
  paragraphs.forEach((p) => container.appendChild(el("p", null, p)));
}

function fmtTime(seconds) {
  const s = Math.round(seconds);
  const m = Math.floor(s / 60);
  return m ? `${m}m ${String(s % 60).padStart(2, "0")}s` : `${s}s`;
}

// ---------------------------------------------------------------------------
// 1. splash
// ---------------------------------------------------------------------------
// Everyone picks a name (shown on the leaderboard + feedback). In LAN mode
// friends also type the host's join code once; it's kept in a cookie.
async function initSplash() {
  const cfg = await api("/api/config");
  if (cfg.name) $("#join-name").value = cfg.name;
  $("#join-code-row").hidden = !cfg.needs_code;
  state.local = !!cfg.local;
  document.documentElement.dataset.board = cfg.local ? "local" : "live";
  $(".live-label").textContent = cfg.local ? "THIS BROWSER" : "LIVE";
  $("#join-name").focus();
}
initSplash();

async function leaveSplash() {
  if (!$("#splash").classList.contains("active")) return;
  const err = $("#join-error");
  const data = await api("/api/join", { name: $("#join-name").value, code: $("#join-code").value });
  if (data.error) {
    err.textContent = data.error;
    err.hidden = false;
    return;
  }
  err.hidden = true;
  state.name = data.name;
  $("#fb-open").hidden = false;
  startLive();
  loadArchive();
  go("hero", "fade");
}
$("#join-form").addEventListener("submit", (e) => { e.preventDefault(); leaveSplash(); });

// ---------------------------------------------------------------------------
// 2. hero / archive
// ---------------------------------------------------------------------------
async function loadArchive() {
  const [{ levels, inbox }, results, mine] = await Promise.all(
    [api("/api/levels"), api("/api/leaderboard"), api("/api/mine")]);
  const solvedIds = new Set(mine.solved || []);
  state.solvedIds = solvedIds;
  renderInbox(inbox);

  const wrap = $("#level-sections");
  wrap.innerHTML = "";
  levels.forEach(({ level, stories: items }) => {
    const copy = LEVEL_COPY[level] || { num: "--", blurb: "" };
    const section = el("section", `level-section level-${level}`);
    const head = el("h2", "level-head");
    head.append(el("span", "num", copy.num), document.createTextNode(level.toUpperCase()),
                el("span", "chip", `${items.length} ${items.length === 1 ? "CASE" : "CASES"}`));
    section.append(head, el("p", "level-blurb", copy.blurb));

    const grid = el("div", "story-grid");
    items.forEach((item) => grid.appendChild(storyCard(item, solvedIds.has(item.story.id))));
    if (!items.length) grid.appendChild(el("p", "level-blurb", "No cases filed at this level yet."));
    section.appendChild(grid);
    wrap.appendChild(section);
  });

  renderBoard(results);
}

// packs picked up from stories_inbox/ during this load of the archive
function renderInbox(inbox) {
  const box = $("#inbox-notice");
  box.innerHTML = "";
  box.hidden = !inbox.length;
  inbox.forEach((r) => {
    const line = el("div", r.ok ? "inbox-ok" : "inbox-bad");
    line.textContent = r.ok
      ? `✦ NEW CASE FILED — ${r.title} [${r.level}]`
      : `✖ REJECTED ${r.file} — ${r.problems} problem${r.problems === 1 ? "" : "s"}. ` +
        `Reasons in stories_inbox/failed/${r.file}.error.txt (may contain spoilers).`;
    box.appendChild(line);
  });
}

function storyCard(item, solved) {
  const { story } = item;
  const p = story.palette;
  const card = el("button", "story-card");
  card.type = "button";

  const art = el("span", "card-art");
  art.style.background = p.bg;
  const doodle = el("span", "doodle");
  doodle.style.color = p.accent;
  paintDoodle(doodle, story.doodle);
  const swatches = el("span", "swatches");
  [p.bg, p.accent, p.accent2, p.note].forEach((c) => {
    const i = el("i");
    i.style.background = c;
    swatches.appendChild(i);
  });
  art.append(doodle, swatches);
  if (solved) art.appendChild(el("span", "card-solved", "SOLVED"));

  const body = el("span", "card-body");
  body.append(el("span", "card-title", story.title), el("span", "card-hook", story.hook),
              el("span", "card-cta", "ENTER STORY →"));
  card.append(art, body);
  card.addEventListener("click", () => openStory(item));
  return card;
}

// timestamps of solves already on screen; anything else is "fresh"
const seenSolves = new Set();
let boardPrimed = false;

function renderBoard(results) {
  const tbody = $("#leaderboard tbody");
  tbody.innerHTML = "";
  // the server sends each player's best score per case, best first
  results.slice(0, 25).forEach((r, i) => {
    const tr = el("tr");
    const fresh = boardPrimed && !seenSolves.has(r.timestamp);
    [i + 1, r.player || "—", r.story_title || r.dataset_id, r.level, r.score ?? "—",
     fmtTime(r.elapsed_seconds), r.attempts]
      .forEach((v) => tr.appendChild(el("td", null, String(v))));
    if (fresh) {
      tr.classList.add("fresh");
      tr.children[1].appendChild(el("span", "fresh-chip", "JUST SOLVED"));
    }
    tbody.appendChild(tr);
  });
  results.forEach((r) => seenSolves.add(r.timestamp));
  boardPrimed = true;
  $("#leaderboard").hidden = results.length === 0;
  $("#board-empty").hidden = results.length > 0;
}

// ---------------------------------------------------------------------------
// 3. story intro
// ---------------------------------------------------------------------------
function openStory(item) {
  state.story = item.story;
  state.meta = item.meta;
  applyTheme(item.story.palette);

  const intro = $("#story-intro");
  $(".intro-level", intro).textContent = `${item.story.level} case`;
  $(".intro-title", intro).textContent = item.story.title;
  renderNarrative($(".intro-narrative", intro), item.story.narrative);
  paintDoodle($(".intro-doodle", intro), item.story.doodle);
  $("#intro-scout").hidden = state.local || !(state.solvedIds && state.solvedIds.has(item.story.id));

  go("story-intro", "travel");
}

$("#intro-back").addEventListener("click", () => go("hero", "fade"));
$("#begin-btn").addEventListener("click", beginInvestigation);

// ---------------------------------------------------------------------------
// 4. story IDE
// ---------------------------------------------------------------------------
async function beginInvestigation() {
  // first visit: Python is still downloading, so say so instead of hanging
  const loader = $("#py-loader");
  loader.hidden = pythonReady;
  $("#begin-btn").disabled = true;
  const data = await api("/api/start", { story_id: state.story.id });
  loader.hidden = true;
  $("#begin-btn").disabled = false;
  if (data.error) { showToast(data.error); return; }
  const { story, meta } = data;

  // top bar
  $(".ide-title").textContent = story.title;
  $("#steps").textContent = "0";
  $("#attempts").textContent = "0";

  // story drawer (same story as the intro, retrievable any time)
  $(".drawer-level").textContent = `${story.level} case`;
  $(".drawer-title").textContent = story.title;
  renderNarrative($(".drawer-narrative"), story.narrative);
  paintDoodle($(".drawer-doodle"), story.doodle);
  setDrawer(false);

  // sticky-note case notes
  $("#notes-desc").textContent = meta.description;
  $("#notes-shape").textContent = `${data.shape[0]} rows × ${data.shape[1]} columns · loaded as df`;
  const cols = $("#notes-cols");
  cols.innerHTML = "";
  Object.entries(meta.columns).forEach(([name, desc]) => {
    const li = el("li");
    li.append(el("code", null, name), document.createTextNode(` · ${desc}`));
    cols.appendChild(li);
  });
  const pkgs = $("#notes-pkgs");
  pkgs.innerHTML = "";
  (data.available_packages || []).forEach((p) => pkgs.appendChild(el("span", null, p)));
  $("#answer-box").value = "";
  $("#hint-list").innerHTML = "";
  setNotes(false);

  // fresh notebook: only df exists in the kernel -- imports are up to you
  $("#cells").innerHTML = "";
  cellSeq = 0;
  newCell("import pandas as pd\nimport numpy as np\nimport matplotlib.pyplot as plt\n\ndf.head()");

  $("#win-overlay").classList.remove("show");
  state.solved = false;
  startTimer();
  go("ide", "travel");
}

function startTimer() {
  stopTimer();
  state.startedAt = Date.now();
  $("#timer").textContent = "0s";
  state.timerHandle = setInterval(() => {
    $("#timer").textContent = fmtTime((Date.now() - state.startedAt) / 1000);
  }, 1000);
}
function stopTimer() {
  if (state.timerHandle) clearInterval(state.timerHandle);
  state.timerHandle = null;
}

function backToArchive() {
  stopTimer();
  setNotes(false);
  setDrawer(false);
  $("#win-overlay").classList.remove("show");
  loadArchive();
  if (!$('[data-panel="weekly"]').hidden) renderWeekly();
  go("hero", "fade");
}
$("#ide-back").addEventListener("click", backToArchive);

// ---------- notebook cells ----------
function autosize(textarea) {
  textarea.style.height = "auto";
  textarea.style.height = textarea.scrollHeight + "px";
}

// stable per-cell ids, so the server can count distinct cells for scoring
let cellSeq = 0;
function newCell(code = "", after = null) {
  const cell = el("div", "cell");
  cell.dataset.cellId = `c${++cellSeq}`;
  const gutter = el("div", "cell-gutter", "[ ]");
  const box = el("div", "cell-box");
  const tools = el("div", "cell-tools");
  const runBtn = el("button", null, "▶ run");
  const delBtn = el("button", null, "delete");
  tools.append(runBtn, delBtn);
  const textarea = el("textarea", "code");
  textarea.spellcheck = false;
  textarea.value = code;
  const output = el("div", "output");
  box.append(tools, textarea, output);
  cell.append(gutter, box);

  if (after) after.after(cell); else $("#cells").appendChild(cell);

  runBtn.addEventListener("click", () => runCell(cell));
  delBtn.addEventListener("click", () => cell.remove());
  textarea.addEventListener("input", () => autosize(textarea));
  textarea.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      runCell(cell);
    } else if (e.key === "Enter" && e.shiftKey) {
      e.preventDefault();
      runCell(cell);
      const next = cell.nextElementSibling;
      (next ? $("textarea", next) : $("textarea", newCell("", cell))).focus();
    } else if (e.key === "Tab") {
      e.preventDefault();
      const s = textarea.selectionStart, en = textarea.selectionEnd;
      textarea.value = textarea.value.slice(0, s) + "    " + textarea.value.slice(en);
      textarea.selectionStart = textarea.selectionEnd = s + 4;
      autosize(textarea);
    }
  });

  requestAnimationFrame(() => autosize(textarea));
  textarea.focus();
  return cell;
}

async function runCell(cell) {
  const gutter = $(".cell-gutter", cell);
  const output = $(".output", cell);
  cell.classList.add("running");
  gutter.textContent = "[*]";
  // a cell that runs long gets a stop button (restarting Python is the only real stop)
  const stopBtn = el("button", "stop-btn", "■ stop");
  stopBtn.addEventListener("click", async () => {
    stopBtn.disabled = true;
    stopBtn.textContent = "stopping…";
    await api("/api/restart");
  });
  const stopTimerId = setTimeout(() => $(".cell-tools", cell).prepend(stopBtn), 2000);
  try {
    const data = await api("/api/run", { code: $("textarea", cell).value, cell_id: cell.dataset.cellId });
    clearTimeout(stopTimerId);
    stopBtn.remove();
    renderOutput(output, data);
    if (typeof data.steps === "number") {
      gutter.textContent = `[${data.steps}]`;
      $("#steps").textContent = data.steps;
    } else {
      gutter.textContent = "[!]";
    }
  } catch (err) {
    output.className = "output error";
    output.textContent = "Request failed: " + err;
    gutter.textContent = "[!]";
  }
  cell.classList.remove("running");
}

function renderOutput(output, data) {
  output.innerHTML = "";
  output.className = "output";
  if (data.error) {
    output.classList.add("error");
    output.textContent = data.error;
    return;
  }
  if (data.stdout) output.appendChild(el("div", null, data.stdout));
  if (data.result && data.result.html) {
    const div = el("div");
    div.innerHTML = data.result.html;  // pandas to_html from our own server
    output.appendChild(div);
  } else if (data.result && data.result.text) {
    output.appendChild(el("div", null, data.result.text));
  }
  (data.images || []).forEach((b64) => {
    const img = el("img");
    img.src = "data:image/png;base64," + b64;
    output.appendChild(img);
  });
}

$("#add-cell").addEventListener("click", () => {
  const last = $("#cells").lastElementChild;
  newCell("", last);
});

// ---------- sticky note ----------
function setNotes(open) {
  $("#notes").classList.toggle("open", open);
  if (open) setTimeout(() => $("#answer-box").focus(), 350);
}
$("#notes-tab").addEventListener("click", () => setNotes(!$("#notes").classList.contains("open")));

// ---------- bookmark ribbon: click to toggle, or drag to pull ----------
const drawer = $("#story-drawer");
const ribbon = $("#ribbon");

function setDrawer(open) {
  drawer.classList.toggle("open", open);
  $(".drawer-inner").setAttribute("aria-hidden", String(!open));
}

let drag = null;
ribbon.addEventListener("pointerdown", (e) => {
  drag = {
    y0: e.clientY,
    h: drawer.offsetHeight,
    wasOpen: drawer.classList.contains("open"),
    moved: false,
    y: 0,
  };
  ribbon.setPointerCapture(e.pointerId);
});
ribbon.addEventListener("pointermove", (e) => {
  if (!drag) return;
  const dy = e.clientY - drag.y0;
  if (!drag.moved && Math.abs(dy) < 5) return;
  drag.moved = true;
  drawer.classList.add("dragging");
  const base = drag.wasOpen ? 0 : -drag.h;
  drag.y = Math.min(0, Math.max(-drag.h, base + dy));
  drawer.style.transform = `translateY(${drag.y}px)`;
});
function endDrag() {
  if (!drag) return;
  drawer.classList.remove("dragging");
  drawer.style.transform = "";
  if (!drag.moved) setDrawer(!drag.wasOpen);
  else setDrawer(drag.y > -drag.h / 2);   // snap to whichever side is closer
  drag = null;
}
ribbon.addEventListener("pointerup", endDrag);
ribbon.addEventListener("pointercancel", endDrag);

// ---------- verdict ----------
async function submitVerdict() {
  if (state.solved) return;
  const answer = $("#answer-box").value.trim();
  if (!answer) return;

  const data = await api("/api/submit", { answer, share: $("#share-scout").checked });
  if (data.error) { showToast(data.error); return; }

  if (data.correct) {
    state.solved = true;
    (state.solvedIds ??= new Set()).add(state.story.id);
    $("#win-scout").hidden = !!state.local;
    stopTimer();
    $("#win-time").textContent = fmtTime(data.elapsed_seconds);
    $("#win-steps").textContent = data.steps;
    $("#win-tries").textContent = data.attempts;
    $("#win-score").textContent = data.score;
    $("#win-explain").textContent = data.explanation;
    paintDoodle($(".win-doodle"), state.story.doodle);
    setNotes(false);
    await playCaseClosed();
    $("#win-overlay").classList.add("show");
    return;
  }

  $("#attempts").textContent = data.attempts;
  const li = el("li");
  li.append(el("span", "wrong-guess", answer), document.createTextNode(data.hint));
  $("#hint-list").appendChild(li);
  $("#answer-box").select();
}
// briefcase splash before the win card; resolves when it's done or skipped
const SPLASH_MS = 3000;
function playCaseClosed() {
  const splash = $("#closed-splash");
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return Promise.resolve();
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      splash.removeEventListener("click", finish);
      document.removeEventListener("keydown", finish);
      splash.classList.add("out");
      setTimeout(() => { splash.classList.remove("play", "out"); resolve(); }, 250);
    };
    splash.classList.remove("play", "out");
    void splash.offsetWidth;  // restart the CSS animations
    splash.classList.add("play");
    const timer = setTimeout(finish, SPLASH_MS);
    splash.addEventListener("click", finish);
    // let the Enter that submitted the verdict settle before keys can skip
    setTimeout(() => { if (!done) document.addEventListener("keydown", finish); }, 400);
  });
}

$("#submit-btn").addEventListener("click", submitVerdict);
$("#answer-box").addEventListener("keydown", (e) => { if (e.key === "Enter") submitVerdict(); });

$("#win-stay").addEventListener("click", () => $("#win-overlay").classList.remove("show"));
$("#win-home").addEventListener("click", backToArchive);

// ---------------------------------------------------------------------------
// Scout: other detectives' notebooks for a case you've closed. The backend
// only returns them once you have a solve of your own for that case.
// ---------------------------------------------------------------------------
function setScout(open) {
  $("#scout").hidden = !open;
}

async function openScout(caseId) {
  setScout(true);
  const list = $("#scout-list");
  const view = $("#scout-view");
  list.innerHTML = "";
  view.innerHTML = "";
  view.appendChild(el("p", "scout-empty", "Loading notebooks…"));
  const data = await api("/api/scout", { case_id: caseId });
  view.innerHTML = "";
  if (data.error) {
    view.appendChild(el("p", "scout-empty", data.error));
    return;
  }
  if (!data.solves.length) {
    view.appendChild(el("p", "scout-empty",
      "No shared notebooks for this case yet. Yours will show up here for the next detective."));
    return;
  }
  view.appendChild(el("p", "scout-empty", "Pick a solve on the left to read its notebook."));
  data.solves.forEach((s, i) => {
    const li = el("li");
    const btn = el("button", "scout-pick");
    btn.type = "button";
    btn.append(el("b", null, `#${i + 1} ${s.player}`),
               el("span", null, `${s.score} pts · ${fmtTime(s.elapsed_seconds)} · ${s.cells} cells · ${s.attempts} ${s.attempts === 1 ? "try" : "tries"}`));
    btn.addEventListener("click", () => {
      list.querySelectorAll(".scout-pick").forEach((b) => b.classList.toggle("on", b === btn));
      showScoutNotebook(s, caseId);
    });
    li.appendChild(btn);
    list.appendChild(li);
  });
}

function showScoutNotebook(solve, caseId) {
  const view = $("#scout-view");
  view.innerHTML = "";
  const head = el("div", "scout-nb-head");
  head.appendChild(el("span", null, `${solve.player}'s notebook · ${solve.score} pts`));
  // forking only makes sense inside the same case's notebook
  const inThisCase = $("#ide").classList.contains("active") && state.story && state.story.id === caseId;
  if (inThisCase) {
    const fork = el("button", "fb-btn", "Fork into my notebook");
    fork.addEventListener("click", () => {
      let last = $("#cells").lastElementChild;
      solve.notebook.forEach((code) => { last = newCell(code, last); });
      setScout(false);
      $("#win-overlay").classList.remove("show");   // back to the notebook to use them
      showToast(`Forked ${solve.notebook.length} cells. Run them to see the outputs.`);
    });
    head.appendChild(fork);
  } else {
    head.appendChild(el("span", "scout-note", "Open the case to fork this notebook"));
  }
  view.appendChild(head);
  (solve.notebook || []).forEach((code, i) => {
    const cell = el("div", "scout-cell");
    cell.append(el("span", "scout-gutter", `[${i + 1}]`), el("pre", null, code));
    view.appendChild(cell);
  });
}

$("#scout-close").addEventListener("click", () => setScout(false));
$("#scout").addEventListener("click", (e) => { if (e.target.id === "scout") setScout(false); });
$("#win-scout").addEventListener("click", () => openScout(state.story.id));
$("#intro-scout").addEventListener("click", () => openScout(state.story.id));

// ---------------------------------------------------------------------------
// Weekly Challenge: one case a week, its own board, past winners, and the
// admin's drop form (validated in the browser with the ingester's checks)
// ---------------------------------------------------------------------------
function countdown(toIso) {
  const ms = Date.parse(toIso) - Date.now();
  if (ms <= 0) return "ended";
  const d = Math.floor(ms / 86_400_000), h = Math.floor(ms / 3_600_000) % 24, m = Math.floor(ms / 60_000) % 60;
  return d ? `${d}d ${h}h left` : h ? `${h}h ${m}m left` : `${m}m left`;
}
const fmtDate = (iso) => new Date(iso).toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

function boardTable(rows) {
  const table = el("table", "mini-board-table");
  const head = el("tr");
  ["#", "Player", "Score", "Time", "Tries"].forEach((h) => head.appendChild(el("th", null, h)));
  table.appendChild(el("thead")).appendChild(head);
  const tbody = table.appendChild(el("tbody"));
  rows.slice(0, 20).forEach((r, i) => {
    const tr = el("tr");
    [i + 1, r.player, r.score, fmtTime(r.elapsed_seconds), r.attempts].forEach((v) => tr.appendChild(el("td", null, String(v))));
    tbody.appendChild(tr);
  });
  return table;
}

let weeklyTimer = null;
async function renderWeekly() {
  const body = $("#weekly-body");
  body.innerHTML = "";
  body.appendChild(el("p", "board-empty", "Loading this week's case…"));
  const data = await api("/api/weekly");
  body.innerHTML = "";
  clearInterval(weeklyTimer);
  if (data.error) {
    body.appendChild(el("p", "board-empty", data.error));
    return;
  }

  if (data.current) {
    const { item, ends_at, board } = data.current;
    const wrap = el("div", "weekly-now");
    const card = storyCard(item, state.solvedIds && state.solvedIds.has(item.story.id));
    const side = el("div", "weekly-side");
    const clock = el("div", "weekly-clock", countdown(ends_at));
    weeklyTimer = setInterval(() => { clock.textContent = countdown(ends_at); }, 30_000);
    side.append(el("div", "weekly-kicker", `THIS WEEK · ${item.level.toUpperCase()}`), clock,
                el("p", "level-blurb", `Closes ${fmtDate(ends_at)}. Only solves from this week count here.`));
    if (board.length) side.appendChild(boardTable(board));
    else side.appendChild(el("p", "board-empty", "Nobody has cracked it yet. First name on the board is still up for grabs."));
    wrap.append(card, side);
    body.appendChild(wrap);
  } else {
    const next = data.upcoming.length ? data.upcoming[data.upcoming.length - 1] : null;
    body.appendChild(el("p", "board-empty", next
      ? `No case this week yet. The next one opens ${fmtDate(next.starts_at)}.`
      : "No case this week yet. Check back soon."));
  }

  if (data.past.length) {
    const past = el("section", "weekly-past");
    past.appendChild(el("h3", "weekly-past-head", "PAST WEEKS"));
    data.past.forEach((w) => {
      const row = el("div", "weekly-past-row");
      row.appendChild(el("b", null, w.title));
      row.appendChild(el("span", null, w.top.length
        ? w.top.map((r, i) => `${["1st", "2nd", "3rd"][i]} ${r.player} (${r.score})`).join(" · ")
        : "no solves"));
      past.appendChild(row);
    });
    body.appendChild(past);
  }

  const admin = el("details", "admin-drop");
  admin.appendChild(el("summary", null, "Case drop (admin)"));
  const adminBody = el("div", "admin-body");
  admin.appendChild(adminBody);
  admin.addEventListener("toggle", () => { if (admin.open) renderAdmin(adminBody); });
  body.appendChild(admin);
}

async function renderAdmin(box) {
  box.innerHTML = "";
  const status = await api("/api/admin/status");
  if (!status.online) {
    box.appendChild(el("p", "board-empty", "The admin tools need the online archive."));
    return;
  }
  const msg = el("p", "admin-msg");

  if (status.guest) {
    box.appendChild(el("p", "level-blurb",
      "Sign in with the admin account to schedule a weekly case. This switches this browser from your guest detective to that account."));
    const form = el("form", "admin-form");
    const email = el("input"); email.type = "email"; email.placeholder = "email"; email.required = true; email.autocomplete = "username";
    const pass = el("input"); pass.type = "password"; pass.placeholder = "password (8+ characters)"; pass.required = true; pass.minLength = 8; pass.autocomplete = "current-password";
    const signIn = el("button", "fb-btn", "Sign in"); signIn.type = "submit";
    const signUp = el("button", "fb-btn ghost", "Create the account"); signUp.type = "button";
    form.append(email, pass, signIn, signUp);
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      msg.textContent = "Signing in…";
      const r = await api("/api/admin/signin", { email: email.value, password: pass.value });
      if (r.error) { msg.textContent = r.error; return; }
      renderAdmin(box);
    });
    signUp.addEventListener("click", async () => {
      if (!form.reportValidity()) return;
      msg.textContent = "Creating the account…";
      const r = await api("/api/admin/signup", { email: email.value, password: pass.value });
      msg.textContent = r.error ? r.error
        : "Check your inbox and confirm the email, then come back here and sign in.";
    });
    box.append(form, msg);
    return;
  }

  const who = el("p", "level-blurb", `Signed in as ${status.email}.`);
  const out = el("button", "fb-btn ghost", "Sign out");
  out.addEventListener("click", async () => { await api("/api/admin/signout"); renderAdmin(box); loadArchive(); });
  who.appendChild(document.createTextNode(" "));
  who.appendChild(out);
  box.appendChild(who);
  if (!status.admin) {
    box.appendChild(el("p", "board-empty", "This account isn't an admin."));
    return;
  }

  const pack = el("textarea", "admin-pack");
  pack.placeholder = "Paste the story pack JSON here (or pick a file below)";
  const file = el("input"); file.type = "file"; file.accept = ".json,.txt,.md";
  file.addEventListener("change", async () => { if (file.files[0]) pack.value = await file.files[0].text(); });
  const validate = el("button", "fb-btn", "Validate pack");
  const result = el("div", "admin-result");

  const dates = el("div", "admin-dates");
  const start = el("input"); start.type = "datetime-local";
  const end = el("input"); end.type = "datetime-local";
  const toLocal = (d) => new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
  start.value = toLocal(new Date());
  end.value = toLocal(new Date(Date.now() + 7 * 86_400_000));
  const sLab = el("label", null, "Opens "); sLab.appendChild(start);
  const eLab = el("label", null, "Closes "); eLab.appendChild(end);
  dates.append(sLab, eLab);
  const publish = el("button", "fb-btn", "Publish this week");
  publish.disabled = true;

  validate.addEventListener("click", async () => {
    validate.disabled = true;
    publish.disabled = true;
    result.innerHTML = "";
    const step = el("p", "admin-msg", "Starting…");
    result.appendChild(step);
    const r = await api("/api/admin/validate", { text: pack.value }, (s) => { step.textContent = s; });
    validate.disabled = false;
    result.innerHTML = "";
    if (r.error || (r.errors && r.errors.length)) {
      result.appendChild(el("p", "admin-bad", "This pack isn't ready:"));
      const ul = el("ul", "admin-errors");
      (r.errors || [r.error]).forEach((e) => ul.appendChild(el("li", null, e)));
      result.appendChild(ul);
      return;
    }
    const s = r.summary;
    result.appendChild(el("p", "admin-ok",
      `Ready: "${s.title}" · ${s.level} · ${s.rows} rows × ${s.columns} columns · id ${s.id}`));
    publish.disabled = false;
  });

  publish.addEventListener("click", async () => {
    publish.disabled = true;
    const r = await api("/api/admin/publish", {
      starts_at: new Date(start.value).toISOString(), ends_at: new Date(end.value).toISOString() });
    if (r.error) { result.appendChild(el("p", "admin-bad", r.error)); publish.disabled = false; return; }
    result.appendChild(el("p", "admin-ok", `Published. It opens ${fmtDate(r.starts_at)} and closes ${fmtDate(r.ends_at)}.`));
    renderWeekly();
  });

  box.append(pack, file, validate, result, dates, publish);
}

document.addEventListener("tabchange", (e) => { if (e.detail === "weekly") renderWeekly(); });

// ---------------------------------------------------------------------------
// tabs: Cases · Weekly · Stakeout · Upload (deep-linkable as #weekly etc.)
// ---------------------------------------------------------------------------
function selectTab(name) {
  const tabs = document.querySelectorAll(".play-tabs [role=tab]");
  if (![...tabs].some((t) => t.dataset.tab === name)) name = "cases";
  tabs.forEach((t) => t.setAttribute("aria-selected", String(t.dataset.tab === name)));
  document.querySelectorAll(".tab-panel").forEach((p) => { p.hidden = p.dataset.panel !== name; });
  document.dispatchEvent(new CustomEvent("tabchange", { detail: name }));
}
document.querySelector(".play-tabs").addEventListener("click", (e) => {
  const tab = e.target.closest("[role=tab]");
  if (!tab) return;
  selectTab(tab.dataset.tab);
  history.replaceState(null, "", tab.dataset.tab === "cases" ? location.pathname : `#${tab.dataset.tab}`);
});
selectTab(location.hash.slice(1));

// ---------------------------------------------------------------------------
// global keys
// ---------------------------------------------------------------------------
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    setScout(false);
    setDrawer(false);
    setNotes(false);
    setFeedback(false);
  }
});

// ---------------------------------------------------------------------------
// live board: every tab polls /api/live -- online count, fresh rows, and a
// toast on any screen when another detective closes a case
// ---------------------------------------------------------------------------
const LIVE_EVERY_MS = 3000;
let liveHandle = null;
let lastBoardSig = "";

function startLive() {
  if (liveHandle) return;
  pollLive();
  liveHandle = setInterval(pollLive, LIVE_EVERY_MS);
}

async function pollLive() {
  let data;
  try { data = await api("/api/live"); } catch { return; }
  if (!data || !data.results) return;

  const n = data.online;
  $("#online-count").textContent = `${n} DETECTIVE${n === 1 ? "" : "S"} ONLINE`;

  const sig = data.results.map((r) => r.timestamp).join(",");
  if (sig === lastBoardSig) return;
  const firstPoll = lastBoardSig === "";
  lastBoardSig = sig;

  if (!firstPoll) {
    data.results.filter((r) => !seenSolves.has(r.timestamp) && r.player !== state.name)
      .forEach((r) => showToast(`⚡ ${r.player} just closed "${r.story_title}" for ${r.score} pts`));
  }
  renderBoard(data.results);
}

let toastTimer = null;
function showToast(text) {
  const t = $("#toast");
  t.textContent = text;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 4500);
}

// ---------------------------------------------------------------------------
// feedback -> results/feedback.json on the host
// ---------------------------------------------------------------------------
let fbRating = null;
function paintStars() {
  document.querySelectorAll("#fb-stars button").forEach((b) =>
    b.classList.toggle("on", fbRating != null && Number(b.dataset.v) <= fbRating));
}
function setFeedback(open) {
  $("#fb-overlay").classList.toggle("show", open);
  if (open) {
    $("#fb-status").textContent = "";
    setTimeout(() => $("#fb-text").focus(), 50);
  }
}
$("#fb-open").addEventListener("click", () => setFeedback(true));
$("#fb-cancel").addEventListener("click", () => setFeedback(false));
$("#fb-stars").addEventListener("click", (e) => {
  const v = e.target.dataset && e.target.dataset.v;
  if (v) { fbRating = Number(v); paintStars(); }
});
$("#fb-card").addEventListener("submit", async (e) => {
  e.preventDefault();
  const data = await api("/api/feedback", { text: $("#fb-text").value, rating: fbRating });
  if (data.error) { $("#fb-status").textContent = data.error; return; }
  $("#fb-text").value = "";
  fbRating = null;
  paintStars();
  $("#fb-status").textContent = "Sent — thanks!";
  setTimeout(() => setFeedback(false), 900);
});
