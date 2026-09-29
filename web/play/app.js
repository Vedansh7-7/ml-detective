// ML Detective -- browser version. Same UI as the desktop app; api() is
// answered in the browser by backend.js (Python runs in a Web Worker).
//
// Flow:  #splash  --fade-->  #hero  --travel-->  #story-intro  --travel-->  #ide
//        (brutalist)         (brutalist)         (story palette)           (story palette)
import { api, onEngineStatus, watchRoom } from "./backend.js";

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
  $("#library-open").hidden = toId !== "hero" || !!state.local;
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
  // arrived through a Stakeout invite link (play/#stakeout/CODE)
  const [tab, code, extra] = location.hash.slice(1).split("/");
  if (tab === "stakeout" && code) enterRoom(code, null, { watch: extra === "watch" });
  if (tab === "upload" && code) openSharedPack(code);
  // from a /learn/ page's "Play this case" button
  if (tab === "case" && code) {
    caseItemById(code).then((item) => { if (item) openStory(item); });
    history.replaceState(null, "", location.pathname);
  }
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
  // inside a running Stakeout for this case, the game is timed against the room
  const room = state.room && state.room.status === "running" && state.room.case_id === state.story.id
    ? state.room.code : undefined;
  const data = await api("/api/start", { story_id: state.story.id, room_code: room });
  loader.hidden = true;
  $("#begin-btn").disabled = false;
  if (data.error) { showToast(data.error); return; }
  const { story, meta } = data;
  state.roomGame = room || null;
  const rules = room ? state.room.settings : null;
  $("#room-stat").hidden = !(room && state.room.ends_at);
  $("#lives-stat").hidden = !(rules && rules.lives);
  if (rules && rules.lives) $("#lives-left").textContent = rules.lives;
  if (room && state.room.ends_at) $("#room-left").textContent = fmtClock(Date.parse(state.room.ends_at) - Date.now());
  $("#answer-box").disabled = false;
  $("#submit-btn").disabled = false;
  $("#answer-box").placeholder = "What's hiding in this data?";

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
  $("#notes-shape").textContent =
    `${data.shape[0]} rows × ${data.shape[1]} columns · loaded as df · load_data() gives you a fresh copy`;
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
  const seed = state.seedCells;
  state.seedCells = null;
  if (seed && seed.length) {
    let last = null;
    seed.forEach((code) => { last = newCell(code, last); });
  } else {
    newCell("import pandas as pd\nimport numpy as np\nimport matplotlib.pyplot as plt\n\n" +
            "# df is the case's data. Broke it? df = load_data() gives you a fresh copy.\ndf.head()");
  }

  $("#win-overlay").classList.remove("show");
  state.solved = false;
  startTimer();
  go("ide", "travel");
  sendProgress("playing");
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
  if (!state.solved) api("/api/save");
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
      sendProgress("playing");
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

$("#reset-vars").addEventListener("click", async () => {
  const r = await api("/api/reset");
  showToast(r.error || "Variables cleared. df is back to the original data.");
});

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
  if (data.error) {
    showToast(data.error);
    if (data.over || data.out) lockVerdict(data.error);
    return;
  }

  if (data.correct) {
    state.solved = true;
    (state.solvedIds ??= new Set()).add(state.story.id);
    $("#win-library").hidden = !!state.local || !!data.custom;   // private uploads aren't saved online
    stopTimer();
    sendProgress("solved");
    if (data.won) showToast("You solved it first. You win the round!");
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
  const rules = inRoomGame() ? state.room.settings : null;
  if (rules && rules.lives) $("#lives-left").textContent = Math.max(0, rules.lives - data.attempts);
  const hint = data.hint || (rules && rules.hints === "off" ? "No hints in this round."
    : rules && rules.hints === "after" ? `Hints unlock ${rules.hints_after} min into the round.` : "");
  const li = el("li");
  li.append(el("span", "wrong-guess", answer), document.createTextNode(hint));
  $("#hint-list").appendChild(li);
  if (data.out) {
    lockVerdict("You're out of guesses for this round.");
    sendProgress("out");
  } else {
    sendProgress("playing");
    $("#answer-box").select();
  }
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
// notebook viewer: your Library, and a Stakeout room's debrief / watch view
// ---------------------------------------------------------------------------
function setViewer(open) {
  $("#viewer").hidden = !open;
}

function openViewer(kicker, title) {
  $("#viewer-kicker").textContent = kicker;
  $("#viewer-title").textContent = title;
  $("#viewer-list").innerHTML = "";
  viewerMessage("Loading…");
  setViewer(true);
}

function viewerMessage(text) {
  const view = $("#viewer-view");
  view.innerHTML = "";
  view.appendChild(el("p", "viewer-empty", text));
}

function fillViewer(entries, onPick) {
  const list = $("#viewer-list");
  list.innerHTML = "";
  entries.forEach((entry) => {
    const li = el("li");
    const btn = el("button", "viewer-pick");
    btn.type = "button";
    btn.append(el("b", null, entry.label), el("span", null, entry.sub));
    btn.addEventListener("click", () => {
      list.querySelectorAll(".viewer-pick").forEach((b) => b.classList.toggle("on", b === btn));
      onPick(entry);
    });
    li.appendChild(btn);
    list.appendChild(li);
  });
}

function showNotebook(heading, cells, actions = []) {
  const view = $("#viewer-view");
  view.innerHTML = "";
  const head = el("div", "viewer-nb-head");
  head.appendChild(el("span", null, heading));
  actions.forEach((a) => head.appendChild(a));
  view.appendChild(head);
  if (!cells || !cells.length) {
    view.appendChild(el("p", "viewer-empty", "No cells were saved for this one."));
    return;
  }
  cells.forEach((code, i) => {
    const cell = el("div", "viewer-cell");
    cell.append(el("span", "viewer-gutter", `[${i + 1}]`), el("pre", null, code));
    view.appendChild(cell);
  });
}

$("#viewer-close").addEventListener("click", () => setViewer(false));
$("#viewer").addEventListener("click", (e) => { if (e.target.id === "viewer") setViewer(false); });

// ---------- Library: every case you've opened, with your notebook ----------
const fmtWhen = (iso) => new Date(iso).toLocaleString(undefined,
  { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

async function openLibrary() {
  const btn = $("#library-open");
  btn.classList.remove("opening");
  void btn.offsetWidth;
  btn.classList.add("opening");
  openViewer("LIBRARY", "Your cases and notebooks");
  const data = await api("/api/library");
  if (data.error) { viewerMessage(data.error); return; }
  if (!data.games.length) {
    viewerMessage("Nothing here yet. Every case you open is kept here, with the notebook you wrote.");
    return;
  }
  viewerMessage("Pick a case on the left to read your notebook.");
  const status = (g) => (g.solved_at ? `solved · ${g.score} pts` : g.notebook ? "unfinished" : "opened");
  fillViewer(data.games.map((g) => ({
    ...g,
    label: g.title,
    sub: `${g.level} · ${status(g)}${g.room_code ? ` · Stakeout ${g.room_code}` : ""} · ${fmtWhen(g.started_at)}`,
  })), (g) => {
    const actions = [];
    if (g.source === "core" && g.notebook && g.notebook.length) {
      const again = el("button", "fb-btn", "Open in a new notebook");
      again.addEventListener("click", async () => {
        const item = await caseItemById(g.case_id);
        if (!item) { showToast("That case can't be reopened here."); return; }
        setViewer(false);
        state.story = item.story;
        state.meta = item.meta;
        state.seedCells = g.notebook;
        applyTheme(item.story.palette);
        await beginInvestigation();
      });
      actions.push(again);
    }
    showNotebook(`${g.title} · ${status(g)}`, g.notebook, actions);
  });
}
$("#library-open").addEventListener("click", openLibrary);
$("#win-library").addEventListener("click", () => {
  $("#win-overlay").classList.remove("show");
  openLibrary();
});

// ---------------------------------------------------------------------------
// Weekly Challenge: one case a week, its own board and past winners.
// Weekly cases are dropped from the hidden admin page (web/admin/).
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
}

document.addEventListener("tabchange", (e) => { if (e.detail === "weekly") renderWeekly(); });

// ---------------------------------------------------------------------------
// Stakeout: friends race the same case. The host opens a room (6-letter code
// + link) with its rules, everyone joins, the host starts a shared countdown,
// and the room board fills up live. The server enforces the rules.
// ---------------------------------------------------------------------------
let roomLink = null;         // { unsub, send } for the live room channel
let roomPoll = null;
let roomClock = null;
const roomSeen = new Set();

const PRESETS = {
  casual:   { label: "Casual", blurb: "No clock, hints on, guess as often as you like.",
              case_mode: "pick", time_limit: 0, win: "score", hints: "on", lives: 0 },
  race:     { label: "Race", blurb: "First correct verdict wins. 10-minute cap.",
              case_mode: "pick", time_limit: 10, win: "race", hints: "on", lives: 0 },
  hardcore: { label: "Hardcore", blurb: "Mystery case, no hints, one guess, 10 minutes.",
              case_mode: "mystery", time_limit: 10, win: "score", hints: "off", lives: 1 },
};
const ROOM_DEFAULTS = { preset: "casual", case_id: null, case_mode: "pick", level: "any", time_limit: 0,
                        win: "score", hints: "on", hints_after: 3, lives: 0, max_players: 10,
                        debrief: true, spectators: false, upload_id: null };
// kept for this browser session only; a new session starts from Casual again
const ROOM_SETTINGS_KEY = "mld.room.settings";
function loadRoomSettings() {
  try { return { ...ROOM_DEFAULTS, ...JSON.parse(sessionStorage.getItem(ROOM_SETTINGS_KEY) || "{}") }; }
  catch { return { ...ROOM_DEFAULTS }; }
}
function saveRoomSettings(s) {
  try { sessionStorage.setItem(ROOM_SETTINGS_KEY, JSON.stringify(s)); } catch { /* storage unavailable */ }
}
function rulesList(s) {
  return [
    s.win === "race" ? "first to solve wins" : "best score wins",
    s.time_limit ? `${s.time_limit} min` : "no time limit",
    s.hints === "off" ? "no hints" : s.hints === "after" ? `hints after ${s.hints_after} min` : "hints on",
    s.lives === 1 ? "one guess" : s.lives ? `${s.lives} guesses` : "unlimited guesses",
    `up to ${s.max_players} players`,
    ...(s.debrief ? ["debrief"] : []),
    ...(s.spectators ? ["spectators allowed"] : []),
  ];
}

async function caseItemById(id) {
  const { levels } = await api("/api/levels");
  for (const { level, stories } of levels) {
    const item = stories.find((s) => s.story.id === id);
    if (item) return { level, ...item };
  }
  return null;
}

async function renderStakeout() {
  if (state.room) return renderRoom();
  const body = $("#stakeout-body");
  body.innerHTML = "";
  const s = loadRoomSettings();
  const [{ levels }, mine] = await Promise.all([api("/api/levels"), api("/api/upload/mine")]);
  const uploads = (mine && mine.uploads) || [];
  if (s.case_mode === "upload" && !uploads.length) s.case_mode = "pick";

  const grid = el("div", "stakeout-grid");
  const host = el("div", "stakeout-box");
  host.appendChild(el("h3", null, "Start a Stakeout"));
  host.appendChild(el("p", "level-blurb", "Pick a case. You'll get a code to send your friends."));

  const pick = el("select", "stakeout-select");
  levels.forEach(({ level, stories }) => {
    const group = el("optgroup");
    group.label = level.toUpperCase();
    stories.forEach(({ story }) => {
      const o = el("option", null, story.title);
      o.value = story.id;
      group.appendChild(o);
    });
    pick.appendChild(group);
  });
  if (s.case_id && [...pick.options].some((o) => o.value === s.case_id)) pick.value = s.case_id;

  // Customize: three presets; Advanced for the individual rules
  const custom = el("details", "room-customize");
  custom.appendChild(el("summary", null, "Customize"));
  const presets = el("div", "preset-row");
  Object.entries(PRESETS).forEach(([key, p]) => {
    const b = el("button", "preset-chip");
    b.type = "button";
    b.dataset.preset = key;
    b.append(el("b", null, p.label), el("span", null, p.blurb));
    b.addEventListener("click", () => {
      Object.assign(s, { preset: key, case_mode: p.case_mode, time_limit: p.time_limit, win: p.win,
                         hints: p.hints, lives: p.lives });
      sync();
    });
    presets.appendChild(b);
  });
  custom.appendChild(presets);

  const adv = el("details", "room-advanced");
  adv.appendChild(el("summary", null, "Advanced"));
  const form = el("div", "adv-grid");
  const bound = [];   // [control, key] pairs to refresh when a preset changes values
  const row = (label, control, note) => {
    const r = el("label", "adv-row");
    r.append(el("span", "adv-label", label), control);
    if (note) r.appendChild(el("small", "adv-note", note));
    form.appendChild(r);
    return r;
  };
  const select = (key, options, asNumber = false) => {
    const sel = el("select", "adv-select");
    options.forEach(([v, t]) => { const o = el("option", null, t); o.value = String(v); sel.appendChild(o); });
    sel.addEventListener("change", () => { s[key] = asNumber ? Number(sel.value) : sel.value; s.preset = "custom"; sync(); });
    bound.push([sel, key]);
    return sel;
  };
  const toggle = (key) => {
    const c = el("input");
    c.type = "checkbox";
    c.addEventListener("change", () => { s[key] = c.checked; s.preset = "custom"; sync(); });
    bound.push([c, key]);
    return c;
  };
  row("Case", select("case_mode", [["pick", "A case I pick"], ["random", "Random case"],
    ["mystery", "Mystery case (revealed at 3-2-1)"], ...(uploads.length ? [["upload", "One of my uploaded cases"]] : [])]));
  const levelRow = row("Level", select("level", [["any", "Any level"], ["easy", "Easy"], ["normal", "Normal"], ["hard", "Hard"]]));
  const uploadRow = row("Uploaded case", select("upload_id", uploads.map((u) => [u.id, `${u.title} (${u.level})`])),
    "Shared with the room by link. It counts on the room board only.");
  row("Time limit", select("time_limit", [[0, "No limit"], [5, "5 minutes"], [10, "10 minutes"],
    [15, "15 minutes"], [20, "20 minutes"]], true));
  row("Winner", select("win", [["score", "Best score when the round ends"], ["race", "First correct verdict (race)"]]));
  row("Hints", select("hints", [["on", "Sharpen after each wrong guess"], ["after", "Unlock after a few minutes"], ["off", "Off"]]));
  const afterRow = row("Hints unlock after", select("hints_after", [[1, "1 minute"], [2, "2 minutes"],
    [3, "3 minutes"], [5, "5 minutes"]], true));
  row("Guesses", select("lives", [[0, "Unlimited (wrong ones cost points)"], [3, "3 lives"], [1, "One guess"]], true));
  const maxIn = el("input", "adv-number");
  maxIn.type = "number"; maxIn.min = "2"; maxIn.max = "10";
  maxIn.addEventListener("change", () => {
    s.max_players = Math.min(10, Math.max(2, Math.floor(Number(maxIn.value) || 10)));
    s.preset = "custom";
    sync();
  });
  bound.push([maxIn, "max_players"]);
  row("Max players", maxIn);
  row("Debrief", toggle("debrief"), "When the round ends, players can read each other's notebooks.");
  row("Spectators", toggle("spectators"), "Watchers see live progress, and each player's code once that player finishes.");
  adv.appendChild(form);
  custom.appendChild(adv);

  const rules = el("p", "room-rules");
  const open = el("button", "brut-btn small", "Open a room");
  const hostMsg = el("p", "admin-msg");

  function sync() {
    if (s.case_mode === "upload" && !s.upload_id && uploads[0]) s.upload_id = uploads[0].id;
    bound.forEach(([c, key]) => { if (c.type === "checkbox") c.checked = !!s[key]; else c.value = String(s[key] ?? ""); });
    presets.querySelectorAll(".preset-chip").forEach((b) => b.classList.toggle("on", b.dataset.preset === s.preset));
    pick.hidden = s.case_mode !== "pick";
    levelRow.hidden = !(s.case_mode === "random" || s.case_mode === "mystery");
    uploadRow.hidden = s.case_mode !== "upload";
    afterRow.hidden = s.hints !== "after";
    s.case_id = pick.value;
    const name = PRESETS[s.preset] ? PRESETS[s.preset].label : "Custom";
    rules.textContent = `${name} · ${rulesList(s).join(" · ")}`;
    saveRoomSettings(s);
  }
  pick.addEventListener("change", sync);

  open.addEventListener("click", async () => {
    open.disabled = true;
    hostMsg.textContent = s.case_mode === "upload" ? "Sharing your case with the room…" : "";
    const settings = { ...s };
    delete settings.case_id;
    const r = await api("/api/rooms/create", { settings, case_id: s.case_mode === "pick" ? pick.value : null });
    open.disabled = false;
    if (r.error) { hostMsg.textContent = r.error; return; }
    hostMsg.textContent = "";
    enterRoom(r.code);
  });
  host.append(pick, custom, rules, open, hostMsg);
  sync();

  const join = el("form", "stakeout-box");
  join.appendChild(el("h3", null, "Join with a code"));
  join.appendChild(el("p", "level-blurb", "Got a code from a friend? Type it in."));
  const code = el("input", "stakeout-code-input");
  code.maxLength = 6; code.placeholder = "K7Q2XM"; code.autocomplete = "off"; code.spellcheck = false;
  const watchBox = el("label", "watch-toggle");
  const watch = el("input");
  watch.type = "checkbox";
  watchBox.append(watch, document.createTextNode(" Just watch (if the room allows spectators)"));
  const go = el("button", "brut-btn small", "Join");
  go.type = "submit";
  const joinMsg = el("p", "admin-msg");
  join.addEventListener("submit", (e) => { e.preventDefault(); enterRoom(code.value, joinMsg, { watch: watch.checked }); });
  join.append(code, watchBox, go, joinMsg);

  grid.append(host, join);
  body.appendChild(grid);
}

function roomFromRow(room, me, extra = {}) {
  return {
    code: room.code, case_id: room.case_id, status: room.status, starts_at: room.starts_at, ends_at: room.ends_at,
    settings: { ...ROOM_DEFAULTS, ...(room.settings || {}) }, host: room.host_id === me,
    title: room.cases ? room.cases.title : null, level: room.cases ? room.cases.level : null,
    winner: room.winner ? room.winner.name : null, people: [], progress: {}, ...extra,
  };
}

async function enterRoom(rawCode, msgEl, { watch = false } = {}) {
  const code = String(rawCode || "").trim().toUpperCase();
  const say = (text) => { if (msgEl) msgEl.textContent = text; else showToast(text); };
  if (watch) {
    const w = await api("/api/rooms/spectate", { code });
    if (w.error) { say(w.error); return; }
  }
  const r = await api("/api/rooms/get", { code });
  if (r.error) { say(r.error); return; }
  leaveRoom(false);
  state.room = roomFromRow(r.room, r.me, { watch });
  selectTab("stakeout");
  history.replaceState(null, "", `#stakeout/${code}${watch ? "/watch" : ""}`);
  renderRoom();

  roomLink = await watchRoom(code, { name: state.name || "detective", watch }, {
    onRoom: async (row) => {
      if (!state.room || state.room.code !== code) return;
      const was = state.room.status;
      const fresh = await api("/api/rooms/get", { code });      // joined names (case, winner)
      if (!state.room || fresh.error) return;
      Object.assign(state.room, roomFromRow(fresh.room, fresh.me, {
        watch: state.room.watch, people: state.room.people, progress: state.room.progress,
      }));
      if (was === "lobby" && row.status === "running" && !state.room.watch) startCountdown(row.starts_at);
      if (row.status === "done" && was !== "done") roundOver();
      renderRoom();
    },
    onPeople: (people) => {
      if (!state.room) return;
      state.room.people = people;
      renderRoom();
    },
    onProgress: (p) => {
      if (!state.room) return;
      state.room.progress[p.id] = p;
      renderRoomProgress();
    },
  });
  pollRoomBoard();
  roomPoll = setInterval(pollRoomBoard, 3000);
  clearInterval(roomClock);
  roomClock = setInterval(tickRoomClock, 1000);
}

function leaveRoom(rerender = true) {
  if (roomLink) roomLink.unsub();
  roomLink = null;
  clearInterval(roomPoll);
  clearInterval(roomClock);
  roomPoll = roomClock = null;
  roomSeen.clear();
  state.room = null;
  state.roomGame = null;
  if (rerender) {
    history.replaceState(null, "", "#stakeout");
    renderStakeout();
  }
}

const inRoomGame = () => !!(state.room && state.roomGame && state.roomGame === state.room.code);

// players tell the room how they're doing (cells run, guesses, status)
function sendProgress(status) {
  if (!inRoomGame() || !roomLink) return;
  roomLink.send({ name: state.name, steps: Number($("#steps").textContent) || 0,
                  tries: Number($("#attempts").textContent) || 0, status });
}

function fmtClock(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function tickRoomClock() {
  const room = state.room;
  if (!room || room.status !== "running" || !room.ends_at) return;
  const left = Date.parse(room.ends_at) - Date.now();
  document.querySelectorAll(".room-left").forEach((n) => { n.textContent = fmtClock(left); });
  if (inRoomGame()) $("#room-left").textContent = fmtClock(left);
  if (left <= 0) {
    room.status = "done";
    roundOver();
    renderRoom();
  }
}

// the round ended (clock, race winner, or the host): lock your verdict, keep your notebook
function roundOver() {
  const room = state.room;
  if (!room || room.overShown) return;
  room.overShown = true;
  if (inRoomGame() && !state.solved) {
    lockVerdict("This round is over.");
    api("/api/save");
    sendProgress("out");
  }
  if (!room.watch) {
    const who = room.winner ? `${room.winner} solved it first.` : "Round over.";
    showToast(room.settings.debrief ? `${who} The debrief is open in the Stakeout tab.` : who);
  }
}

function lockVerdict(reason) {
  $("#answer-box").disabled = true;
  $("#submit-btn").disabled = true;
  $("#answer-box").placeholder = reason;
}

let roomBoardRows = [];
async function pollRoomBoard() {
  if (!state.room) return;
  const code = state.room.code;
  const r = await api("/api/rooms/board", { code });
  if (r.error || !state.room || state.room.code !== code) return;
  const fresh = r.results.filter((x) => !roomSeen.has(x.timestamp));
  if (roomSeen.size) {
    fresh.filter((x) => x.player !== state.name)
      .forEach((x) => showToast(`⚡ ${x.player} just closed it — ${x.score} pts in ${fmtTime(x.elapsed_seconds)}`));
  }
  r.results.forEach((x) => roomSeen.add(x.timestamp));
  roomSeen.add("primed");
  roomBoardRows = r.results;
  const box = $("#room-board");
  if (box) {
    box.innerHTML = "";
    box.appendChild(roomBoardRows.length ? boardTable(roomBoardRows)
      : el("p", "board-empty", "No one has closed it yet."));
  }
}

function renderRoomProgress() {
  const box = $("#room-progress");
  if (!box || !state.room) return;
  box.innerHTML = "";
  const rows = Object.values(state.room.progress);
  if (!rows.length) { box.appendChild(el("p", "board-empty", "No one has started yet.")); return; }
  const t = el("table", "progress-table");
  const head = el("tr");
  ["Detective", "Cells run", "Guesses", ""].forEach((h) => head.appendChild(el("th", null, h)));
  t.appendChild(head);
  rows.forEach((p) => {
    const tr = el("tr");
    const status = p.status === "solved" ? "✓ solved" : p.status === "out" ? "finished" : "investigating…";
    [p.name, p.steps, p.tries, status].forEach((v) => tr.appendChild(el("td", null, String(v))));
    t.appendChild(tr);
  });
  box.appendChild(t);
}

function renderRoom() {
  const body = $("#stakeout-body");
  if (!state.room || !body) return;
  const room = state.room;
  const s = room.settings;
  body.innerHTML = "";

  const head = el("div", "room-head");
  const codeBox = el("div", "room-code");
  codeBox.append(el("span", null, "ROOM"), el("b", null, room.code));
  const link = `${location.origin}${location.pathname}#stakeout/${room.code}`;
  const copy = el("button", "fb-btn", "Copy invite link");
  copy.addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(link); copy.textContent = "Copied"; } catch { copy.textContent = link; }
  });
  const leave = el("button", "fb-btn ghost", "Leave room");
  leave.addEventListener("click", () => leaveRoom());
  const info = el("div", "room-info");
  const caseLabel = room.title || (s.case_mode === "mystery" ? "Mystery case" : s.case_mode === "random" ? "Random case"
    : s.case_mode === "upload" ? "An uploaded case" : "A case");
  const levelLabel = room.level || (s.level !== "any" ? s.level : "any level");
  info.append(el("div", "weekly-kicker", `${levelLabel.toUpperCase()} · ${room.watch ? "WATCHING" : "STAKEOUT"}`),
              el("h3", null, room.status === "lobby" && s.case_mode === "mystery" ? "Mystery case" : caseLabel));
  head.append(codeBox, info, copy);
  if (s.spectators) {
    const watchCopy = el("button", "fb-btn ghost", "Copy watch link");
    watchCopy.addEventListener("click", async () => {
      try { await navigator.clipboard.writeText(`${link}/watch`); watchCopy.textContent = "Copied"; }
      catch { watchCopy.textContent = `${link}/watch`; }
    });
    head.appendChild(watchCopy);
  }
  head.appendChild(leave);
  body.appendChild(head);

  const rules = el("div", "room-rule-chips");
  rulesList(s).forEach((r) => rules.appendChild(el("span", "rule-chip", r)));
  body.appendChild(rules);

  const people = el("div", "room-people");
  const players = room.people.filter((p) => !p.watch);
  const watchers = room.people.length - players.length;
  people.appendChild(el("span", "weekly-kicker",
    `${players.length || 1} IN THE ROOM${watchers ? ` · ${watchers} WATCHING` : ""}`));
  (players.length ? players : [{ name: state.name }]).forEach((p) => people.appendChild(el("span", "room-chip", p.name)));
  body.appendChild(people);

  const action = el("div", "room-action");
  if (room.status === "lobby") {
    if (room.watch) {
      action.appendChild(el("p", "level-blurb", "You're watching. The round starts when the host is ready."));
    } else if (room.host) {
      const start = el("button", "brut-btn", "Start the Stakeout");
      start.addEventListener("click", async () => {
        start.disabled = true;
        const r = await api("/api/rooms/start", { code: room.code });
        if (r.error) { start.disabled = false; showToast(r.error); }
      });
      action.append(start, el("p", "level-blurb", "Everyone gets a 5-second countdown, then the case opens for all of you."));
    } else {
      action.appendChild(el("p", "level-blurb", "Waiting for the host to start. The case opens for everyone at once."));
    }
  } else if (room.status === "running") {
    if (room.ends_at) action.appendChild(el("p", "room-clock", "")).append("Time left ", el("b", "room-left", fmtClock(Date.parse(room.ends_at) - Date.now())));
    if (room.watch) {
      action.appendChild(el("p", "level-blurb", "The Stakeout is on. Finished players' notebooks open below as they finish."));
    } else {
      const openCase = el("button", "brut-btn", state.solvedIds && state.solvedIds.has(room.case_id) ? "Open the case again" : "Open the case");
      openCase.addEventListener("click", () => openRoomCase());
      action.append(el("p", "level-blurb", "The Stakeout is on."), openCase);
    }
    if (room.host) {
      const end = el("button", "fb-btn ghost", "End the round");
      end.addEventListener("click", async () => {
        end.disabled = true;
        const r = await api("/api/rooms/end", { code: room.code });
        if (r.error) { end.disabled = false; showToast(r.error); }
      });
      action.appendChild(end);
    }
  } else {
    action.appendChild(el("p", "room-over", room.winner ? `Round over. ${room.winner} solved it first.` : "Round over."));
  }
  const canRead = (room.watch && room.status !== "lobby") || (room.status === "done" && s.debrief && !room.watch);
  if (canRead) {
    const read = el("button", "brut-btn small", room.watch ? "Read finished players' notebooks" : "Debrief: read everyone's notebooks");
    read.addEventListener("click", () => openRoomNotebooks(room.code));
    action.appendChild(read);
  }
  body.appendChild(action);

  if (room.watch) {
    body.appendChild(el("h3", "weekly-past-head", "LIVE PROGRESS"));
    const progress = el("div", null);
    progress.id = "room-progress";
    body.appendChild(progress);
    renderRoomProgress();
  }

  body.appendChild(el("h3", "weekly-past-head", "ROOM BOARD"));
  const board = el("div", null);
  board.id = "room-board";
  board.appendChild(roomBoardRows.length ? boardTable(roomBoardRows) : el("p", "board-empty", "No one has closed it yet."));
  body.appendChild(board);
}

async function openRoomNotebooks(code) {
  openViewer(state.room && state.room.watch ? "WATCHING" : "DEBRIEF", "How everyone worked it");
  const data = await api("/api/rooms/notebooks", { code });
  if (data.error) { viewerMessage(data.error); return; }
  if (!data.notebooks.length) { viewerMessage("No notebooks to show yet. They appear as players finish."); return; }
  viewerMessage("Pick a detective on the left to read their notebook.");
  fillViewer(data.notebooks.map((n) => ({
    ...n,
    label: n.player,
    sub: n.solved ? `solved · ${n.score} pts · ${fmtTime(n.elapsed_seconds)}` : `didn't solve · ${n.attempts} ${n.attempts === 1 ? "guess" : "guesses"}`,
  })), (n) => showNotebook(`${n.player}'s notebook`, n.notebook));
}

function startCountdown(startsAt) {
  const overlay = $("#countdown");
  const label = $("span", overlay);
  overlay.hidden = false;
  const tick = () => {
    const left = Math.ceil((Date.parse(startsAt) - Date.now()) / 1000);
    if (left <= 0 || left > 10) {           // clocks disagree by more than a few seconds: just go
      label.textContent = "GO";
      setTimeout(() => { overlay.hidden = true; openRoomCase(); }, 600);
      return;
    }
    label.textContent = String(left);
    label.classList.remove("pop"); void label.offsetWidth; label.classList.add("pop");
    setTimeout(tick, 1000);
  };
  tick();
}

async function openRoomCase() {
  if (!state.room || state.room.watch) return;
  let item = state.room.case_id ? await caseItemById(state.room.case_id) : null;
  if (!item && state.room.case_id && state.room.case_id.startsWith("pack_")) {
    showToast("Opening the host's case…");
    const r = await api("/api/rooms/pack", { pack_code: state.room.settings.pack_code, case_id: state.room.case_id });
    if (r.error) { showToast(r.error); return; }
    item = r.item;
  }
  if (!item) { showToast("That case isn't in this version of the site."); return; }
  state.story = item.story;
  state.meta = item.meta;
  applyTheme(item.story.palette);
  await beginInvestigation();
}

document.addEventListener("tabchange", (e) => { if (e.detail === "stakeout") renderStakeout(); });

// ---------------------------------------------------------------------------
// Upload: write your own case with the master prompt, check it here with the
// same rules as the built-in cases, play it privately or share a link.
// ---------------------------------------------------------------------------
let promptText = null;
async function masterPrompt() {
  if (!promptText) {
    const md = await fetch("story-prompt.md").then((r) => r.text());
    // the real markers sit on their own lines (the usage notes above them mention them inline)
    const m = md.match(/^=== PROMPT START ===\s*$([\s\S]*?)^=== PROMPT END ===\s*$/m);
    promptText = (m ? m[1] : md).trim();
  }
  return promptText;
}

function packErrors(box, errors) {
  box.appendChild(el("p", "admin-bad", "This pack isn't ready yet. Paste this list back to the AI and ask it to fix the pack:"));
  const ul = el("ul", "admin-errors");
  errors.forEach((e) => ul.appendChild(el("li", null, e)));
  box.appendChild(ul);
}

function playItem(item) {
  openStory(item);
}

async function renderUpload() {
  const body = $("#upload-body");
  body.innerHTML = "";
  // fetch now, so the copy button writes to the clipboard straight from the click
  // (browsers can refuse a clipboard write that happens after a network wait)
  masterPrompt().catch(() => {});

  const steps = el("ol", "upload-steps");
  const s1 = el("li");
  s1.appendChild(el("b", null, "Get the master prompt. "));
  s1.appendChild(document.createTextNode("Paste it into any AI chat and pick a difficulty and a setting."));
  const copy = el("button", "fb-btn", "Copy the master prompt");
  copy.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(promptText ?? await masterPrompt());
      copy.textContent = "Copied";
    } catch {
      window.open("story-prompt.md", "_blank");   // no clipboard access: show the file instead
    }
  });
  s1.appendChild(copy);
  const s2 = el("li");
  s2.appendChild(el("b", null, "Drop the AI's reply here. "));
  s2.appendChild(document.createTextNode("Don't read it first: it contains the answer. Code fences and chatter around the JSON are fine."));
  steps.append(s1, s2);
  body.appendChild(steps);

  const pack = el("textarea", "admin-pack");
  pack.placeholder = "Paste the story pack here";
  const file = el("input"); file.type = "file"; file.accept = ".json,.txt,.md";
  file.addEventListener("change", async () => { if (file.files[0]) pack.value = await file.files[0].text(); });
  const check = el("button", "brut-btn small", "Check my case");
  const result = el("div", "admin-result");
  body.append(pack, file, check, result);

  check.addEventListener("click", async () => {
    if (!pack.value.trim()) return;
    check.disabled = true;
    result.innerHTML = "";
    const step = el("p", "admin-msg", "Starting…");
    result.appendChild(step);
    const r = await api("/api/upload/validate", { text: pack.value }, (s) => { step.textContent = s; });
    check.disabled = false;
    result.innerHTML = "";
    if (r.error || r.errors.length) { packErrors(result, r.errors || [r.error]); return; }
    const s = r.summary;
    result.appendChild(el("p", "admin-ok", `Your case is ready: "${s.title}" · ${s.level} · ${s.rows} rows × ${s.columns} columns.`));
    const actions = el("div", "upload-actions");
    const play = el("button", "brut-btn small", "Play it now");
    play.addEventListener("click", async () => {
      const p = await api("/api/upload/play");
      if (p.error) { showToast(p.error); return; }
      playItem(p.item);
    });
    const share = el("button", "fb-btn", "Share a link");
    const shareOut = el("span", "upload-link");
    share.addEventListener("click", async () => {
      share.disabled = true;
      const sh = await api("/api/upload/share");
      if (sh.error) { shareOut.textContent = sh.error; share.disabled = false; return; }
      const link = `${location.origin}${location.pathname}#upload/${sh.code}`;
      shareOut.textContent = link;
      try { await navigator.clipboard.writeText(link); share.textContent = "Link copied"; } catch { /* shown above */ }
    });
    actions.append(play, share, shareOut);
    result.appendChild(actions);
    result.appendChild(el("p", "level-blurb",
      "Uploaded cases are unranked: they don't go on the boards, and whoever opens your link can play them."));
    renderMyUploads(mine);
  });

  const mine = el("section", "weekly-past");
  body.appendChild(mine);
  renderMyUploads(mine);
}

async function renderMyUploads(box) {
  const { uploads } = await api("/api/upload/mine");
  box.innerHTML = "";
  if (!uploads.length) return;
  box.appendChild(el("h3", "weekly-past-head", "MY CASES (THIS BROWSER)"));
  uploads.forEach((u) => {
    const row = el("div", "weekly-past-row");
    row.append(el("b", null, u.title), el("span", null, u.level));
    const replay = el("button", "fb-btn ghost", "Play");
    replay.addEventListener("click", async () => {
      replay.disabled = true;
      replay.textContent = "Loading…";
      const r = await api("/api/upload/replay", { id: u.id });
      replay.disabled = false;
      replay.textContent = "Play";
      if (r.error || (r.errors && r.errors.length)) { showToast(r.error || r.errors[0]); return; }
      playItem(r.item);
    });
    row.appendChild(replay);
    box.appendChild(row);
  });
}

async function openSharedPack(code) {
  selectTab("upload");
  showToast("Opening the shared case…");
  const r = await api("/api/upload/open", { code });
  if (r.error || (r.errors && r.errors.length)) { showToast(r.error || r.errors[0]); return; }
  playItem(r.item);
}

document.addEventListener("tabchange", (e) => { if (e.detail === "upload") renderUpload(); });

// ---------------------------------------------------------------------------
// tabs: Cases · Weekly · Stakeout · Upload (deep-linkable as #weekly etc.)
// ---------------------------------------------------------------------------
function selectTab(name) {
  name = String(name || "").split("/")[0];            // "#stakeout/CODE" -> stakeout
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
    setViewer(false);
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
