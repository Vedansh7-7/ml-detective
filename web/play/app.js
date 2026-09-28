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
  const [{ levels, inbox }, results] = await Promise.all([api("/api/levels"), api("/api/leaderboard")]);
  const solvedIds = new Set(results.map((r) => r.dataset_id));
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

  const data = await api("/api/submit", { answer });
  if (data.error) { showToast(data.error); return; }

  if (data.correct) {
    state.solved = true;
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
