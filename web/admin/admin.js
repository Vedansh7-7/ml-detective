// The case room: a hidden admin board (not linked anywhere, noindex).
// Sign-in is a magic link to an existing admin account only, then a code
// from an authenticator app; the session is stored separately from the
// player's guest session. Everything shown here
// is also enforced server-side: admin_overview() and the waitlist/feedback
// reads refuse anyone who isn't in `admins` or hasn't entered the code.
import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.2/+esm";
import { captchaToken } from "../play/captcha.js";
import { SUPABASE_KEY, SUPABASE_URL } from "../play/config.js";

const sb = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { storageKey: "mld-admin-auth", persistSession: true, detectSessionInUrl: true, flowType: "implicit" },
});

const $ = (s) => document.querySelector(s);
function el(tag, text, cls) {
  const n = document.createElement(tag);
  if (text != null) n.textContent = text;
  if (cls) n.className = cls;
  return n;
}
const views = ["#v-signin", "#v-mfa", "#v-denied", "#v-board"];
function show(id) {
  views.forEach((v) => { $(v).hidden = v !== id; });
}
const when = (iso) => new Date(iso).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const secs = (s) => (s >= 60 ? `${Math.floor(s / 60)}m ${String(Math.round(s % 60)).padStart(2, "0")}s` : `${Math.round(s)}s`);

function table(rows, columns) {
  if (!rows.length) return el("p", "Nothing yet.", "empty");
  const t = el("table");
  const head = el("tr");
  columns.forEach(([label]) => head.appendChild(el("th", label)));
  t.appendChild(el("thead")).appendChild(head);
  const body = t.appendChild(el("tbody"));
  rows.forEach((r) => {
    const tr = el("tr");
    columns.forEach(([, get, cls]) => tr.appendChild(el("td", String(get(r) ?? ""), cls)));
    body.appendChild(tr);
  });
  return t;
}

// ---------------------------------------------------------------- sign in
$("#signin-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const msg = $("#signin-msg");
  msg.textContent = "Sending…";
  let token;
  try { token = await captchaToken(); } catch { token = undefined; }
  await sb.auth.signInWithOtp({
    email: $("#email").value.trim(),
    options: { shouldCreateUser: false, emailRedirectTo: location.origin + "/admin/", captchaToken: token },
  });
  // same message either way: this page never confirms which addresses have access
  msg.textContent = "If that address has access, a sign-in link is on its way. Open it in this browser.";
});

$("#signout").addEventListener("click", async () => {
  await sb.auth.signOut();
  location.replace(location.pathname);
});
$("#refresh").addEventListener("click", () => loadBoard());

// ---------------------------------------------------------------- second factor
// The emailed link alone gives an aal1 session, which the database and the
// admin function treat as "not an admin". The authenticator code lifts it to aal2.
let factorId = null;

async function needSecondFactor() {
  const { data: level } = await sb.auth.mfa.getAuthenticatorAssuranceLevel();
  if (level?.currentLevel === "aal2") return false;
  const { data: factors, error } = await sb.auth.mfa.listFactors();
  if (error) throw error;
  if (factors.totp.length) {                  // set up already: just ask for the code
    factorId = factors.totp[0].id;
    $("#mfa-title").textContent = "Enter your code";
    $("#mfa-enrol").hidden = true;
  } else {                                    // first sign-in: set up an authenticator
    for (const f of factors.all.filter((f) => f.status !== "verified")) {
      await sb.auth.mfa.unenroll({ factorId: f.id });   // leftovers from an unfinished setup
    }
    const { data, error: err } = await sb.auth.mfa.enroll({ factorType: "totp", friendlyName: "ML Detective admin" });
    if (err) throw err;
    factorId = data.id;
    $("#mfa-title").textContent = "Set up your authenticator";
    $("#mfa-qr").src = data.totp.qr_code;
    $("#mfa-secret").textContent = data.totp.secret;
    $("#mfa-enrol").hidden = false;
  }
  show("#v-mfa");
  $("#mfa-code").focus();
  return true;
}

$("#mfa-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const msg = $("#mfa-msg");
  msg.textContent = "Checking…";
  const { error } = await sb.auth.mfa.challengeAndVerify({ factorId, code: $("#mfa-code").value.trim() });
  if (error) { msg.textContent = "That code didn't work. Wait for the next one and try again."; return; }
  msg.textContent = "";
  $("#mfa-code").value = "";
  start();
});

async function start() {
  const { data: { session } } = await sb.auth.getSession();
  if (!session || session.user.is_anonymous) { show("#v-signin"); return; }
  $("#who").textContent = session.user.email || "";
  $("#signout").hidden = false;
  if (location.hash.includes("access_token")) history.replaceState(null, "", location.pathname);
  try {
    if (await needSecondFactor()) return;
  } catch (err) {
    console.warn("mfa:", err);
    show("#v-denied");
    return;
  }
  const { data: admin } = await sb.rpc("is_admin");
  if (!admin) { show("#v-denied"); return; }
  $("#refresh").hidden = false;
  show("#v-board");
  loadBoard();
}

// ---------------------------------------------------------------- board
let waitlistRows = [];

async function loadBoard() {
  const [{ data: o, error }, wl, fb, wk] = await Promise.all([
    sb.rpc("admin_overview"),
    sb.from("waitlist").select("*").order("created_at", { ascending: false }).limit(1000),
    sb.from("feedback").select("created_at, rating, text, case_id, players(name)").order("created_at", { ascending: false }).limit(200),
    sb.from("weekly_challenges").select("case_id, starts_at, ends_at, cases(title, level)").order("starts_at", { ascending: false }).limit(20),
  ]);
  if (error) { $("#kpis").replaceChildren(el("p", error.message, "bad")); return; }

  const kpis = [
    ["Players", o.players, `+${o.players_7d} this week`],
    ["Active (7d)", o.active_7d, `${o.games_7d} games started`],
    ["Solves", o.solves, `+${o.solves_7d} this week`],
    ["Waitlist", o.waitlist, `+${o.waitlist_7d} this week`],
    ["Stakeouts (7d)", o.rooms_7d, ""],
    ["Shared cases", o.shared_packs, ""],
    ["Feedback", o.feedback, ""],
    ["Guest accounts", o.guests, "removed after 45 idle days"],
  ];
  $("#kpis").replaceChildren(...kpis.map(([label, n, sub]) => {
    const k = el("div", null, "kpi");
    k.append(el("span", label), el("b", String(n)), el("em", sub));
    return k;
  }));

  const max = Math.max(1, ...o.daily.flatMap((d) => [d.games, d.solves, d.new_players]));
  $("#daily").replaceChildren(...o.daily.map((d) => {
    const day = el("div", null, "day");
    [["games", "k-games"], ["solves", "k-solves"], ["new_players", "k-new"]].forEach(([k, cls]) => {
      const bar = el("i", null, cls);
      bar.style.height = `${(d[k] / max) * 100}%`;
      bar.title = `${d.day}: ${d[k]} ${k.replace("_", " ")}`;
      day.appendChild(bar);
    });
    day.appendChild(el("small", d.day.slice(8)));
    return day;
  }));

  $("#top-cases").replaceChildren(table(o.top_cases, [
    ["Case", (r) => r.title], ["Level", (r) => r.level], ["Source", (r) => r.source],
    ["Tried by", (r) => r.players_tried], ["Solves", (r) => r.solves],
  ]));
  $("#recent").replaceChildren(table(o.recent_solves, [
    ["When", (r) => when(r.created_at)], ["Player", (r) => r.player], ["Case", (r) => r.title],
    ["Score", (r) => r.score], ["Time", (r) => secs(r.elapsed_seconds)], ["Tries", (r) => r.attempts],
    ["Room", (r) => r.room_code || ""],
  ]));

  waitlistRows = wl.data || [];
  $("#wl-count").textContent = String(waitlistRows.length);
  $("#waitlist").replaceChildren(table(waitlistRows, [
    ["When", (r) => when(r.created_at)], ["Name", (r) => r.name], ["Email", (r) => r.email],
    ["Role", (r) => r.role], ["Organisation", (r) => r.organization], ["How they'd use it", (r) => r.use_case, "wrap"],
    ["Updates OK", (r) => (r.consent ? "yes" : "no")], ["From", (r) => r.source],
  ]));
  $("#feedback").replaceChildren(table(fb.data || [], [
    ["When", (r) => when(r.created_at)], ["Player", (r) => r.players?.name || ""], ["★", (r) => r.rating ?? ""],
    ["Case", (r) => r.case_id || ""], ["Note", (r) => r.text, "wrap"],
  ]));
  $("#weeks").replaceChildren(table(wk.data || [], [
    ["Case", (r) => r.cases?.title], ["Level", (r) => r.cases?.level],
    ["Opens", (r) => when(r.starts_at)], ["Closes", (r) => when(r.ends_at)],
    ["Status", (r) => (Date.now() < Date.parse(r.starts_at) ? "upcoming" : Date.now() > Date.parse(r.ends_at) ? "done" : "LIVE")],
  ]));
}

$("#wl-csv").addEventListener("click", () => {
  const cols = ["created_at", "name", "email", "role", "organization", "use_case", "consent", "source"];
  const esc = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const csv = [cols.join(","), ...waitlistRows.map((r) => cols.map((c) => esc(r[c])).join(","))].join("\n");
  const a = el("a");
  a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
  a.download = `ml-detective-waitlist-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
});

// ---------------------------------------------------------------- weekly drop
let engine = null;
let ready = null;   // the last pack that passed validation
const toLocal = (d) => new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
$("#opens").value = toLocal(new Date());
$("#closes").value = toLocal(new Date(Date.now() + 7 * 86_400_000));
$("#pack-file").addEventListener("change", async (e) => {
  if (e.target.files[0]) $("#pack").value = await e.target.files[0].text();
});

$("#validate").addEventListener("click", async () => {
  const out = $("#pack-result");
  $("#validate").disabled = true;
  $("#publish").disabled = true;
  ready = null;
  const step = el("p", "Starting…");
  out.replaceChildren(step);
  try {
    if (!engine) {
      const { Engine } = await import("../play/engine.js");
      engine = new Engine(() => {});
    }
    const { processPack } = await import("../play/packlab.js");
    const res = await processPack($("#pack").value, engine, (s) => { step.textContent = s; });
    if (res.errors.length) {
      const ul = el("ul", null, "errors");
      res.errors.forEach((e) => ul.appendChild(el("li", e)));
      out.replaceChildren(el("p", "This pack isn't ready:", "bad"), ul);
      return;
    }
    ready = res;
    const { story, meta } = res.case;
    out.replaceChildren(el("p",
      `Ready: "${story.title}" · ${story.level} · ${meta.n_rows} rows × ${Object.keys(meta.columns).length} columns · id ${story.id}`, "ok"));
    $("#publish").disabled = false;
  } catch (err) {
    out.replaceChildren(el("p", String(err.message || err), "bad"));
  } finally {
    $("#validate").disabled = false;
  }
});

$("#publish").addEventListener("click", async () => {
  if (!ready) return;
  $("#publish").disabled = true;
  const { data, error } = await sb.functions.invoke("admin", { body: {
    action: "drop_weekly", case: ready.case, csv: ready.csv,
    starts_at: new Date($("#opens").value).toISOString(), ends_at: new Date($("#closes").value).toISOString(),
  } });
  let res = data;
  if (error) { try { res = await error.context.json(); } catch { res = { error: error.message }; } }
  if (!res || res.error) {
    $("#pack-result").appendChild(el("p", (res && res.error) || "publishing failed", "bad"));
    $("#publish").disabled = false;
    return;
  }
  $("#pack-result").appendChild(el("p", `Published. Opens ${when(res.starts_at)}, closes ${when(res.ends_at)}.`, "ok"));
  ready = null;
  loadBoard();
});

start();
