// Online mode: Supabase session, shared boards, server-checked verdicts,
// the Library, Stakeout rooms and presence. backend.js falls back to local play if this can't
// connect (offline, or guest sign-in unavailable).
import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.2/+esm";
import { captchaToken } from "./captcha.js";
import { SUPABASE_KEY, SUPABASE_URL } from "./config.js";

export const sb = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true },
});

let user = null;

// a guest session (anonymous auth) that survives reloads in this browser
export async function connect({ captchaWaitMs = 20_000 } = {}) {
  const { data } = await sb.auth.getSession();
  if (data.session) {
    user = data.session.user;
    return user;
  }
  // if the bot check can't produce a token, still try: it only matters once
  // CAPTCHA is enforced in Supabase, and then the sign-in fails cleanly
  const token = await captchaToken(captchaWaitMs).catch((err) => {
    console.warn("ML Detective: bot check --", err.message);
    return undefined;
  });
  const { data: signed, error } = await sb.auth.signInAnonymously({ options: { captchaToken: token } });
  if (error) throw error;
  user = signed.user;
  return user;
}

export function currentUser() {
  return user;
}

export async function myName() {
  if (!user) return null;
  const { data } = await sb.from("players").select("name").eq("id", user.id).maybeSingle();
  return data ? data.name : null;
}

export async function setName(name) {
  const { error } = await sb.from("players").upsert({ id: user.id, name });
  if (error) throw error;
}

// board rows in the shape the UI (and scoring.rank) already uses
export async function boardRows({ caseIds = null, roomCode = null, since = null, until = null, source = caseIds ? null : "core" } = {}) {
  let q = sb.from("board").select("*").order("created_at", { ascending: false }).limit(1000);
  if (source) q = q.eq("source", source);
  if (roomCode) q = q.eq("room_code", roomCode);   // room board; otherwise every solve counts
  if (caseIds) q = q.in("case_id", caseIds);
  if (since) q = q.gte("created_at", since);
  if (until) q = q.lte("created_at", until);
  const { data, error } = await q;
  if (error) throw error;
  return data.map((r) => ({
    player: r.player,
    dataset_id: r.case_id,
    story_title: r.story_title,
    level: r.level,
    par: r.par,
    elapsed_seconds: r.elapsed_seconds,
    steps: r.steps,
    attempts: r.attempts,
    cells: r.cells,
    errored_cells: r.errored_cells,
    runtime_seconds: r.runtime_seconds,
    timestamp: Date.parse(r.created_at) / 1000,
  }));
}

export async function callGame(payload) {
  const { data, error } = await sb.functions.invoke("game", { body: payload });
  if (error) {
    // surface the function's own error message when there is one
    try { return await error.context.json(); } catch { return { error: error.message }; }
  }
  return data;
}

export async function mySolvedCases() {
  const { data, error } = await sb.from("solves").select("case_id").eq("player_id", user.id);
  if (error) throw error;
  return [...new Set(data.map((r) => r.case_id))];
}

// Library: this player's own past games (solved or not) with their notebooks
export async function library() {
  const { data, error } = await sb.rpc("my_library");
  if (error) throw error;
  return data;
}

// save an unsolved game's notebook for the Library; `keepalive` lets it
// finish while the tab is closing
export async function saveNotebook(gameId, notebook, { keepalive = false } = {}) {
  if (!keepalive) return callGame({ action: "save_notebook", game_id: gameId, notebook });
  const { data } = await sb.auth.getSession();
  if (!data.session) return null;
  return fetch(`${SUPABASE_URL}/functions/v1/game`, {
    method: "POST",
    keepalive: true,
    headers: { "Content-Type": "application/json", apikey: SUPABASE_KEY,
               Authorization: `Bearer ${data.session.access_token}` },
    body: JSON.stringify({ action: "save_notebook", game_id: gameId, notebook }),
  }).catch(() => null);
}

export async function sendFeedback(row) {
  const { error } = await sb.from("feedback").insert({ player_id: user.id, ...row });
  if (error) throw error;
}

// ---------- Weekly Challenge ----------
export const weeklyCsvUrl = (caseId) =>
  `${SUPABASE_URL}/storage/v1/object/public/cases/weekly/${caseId}.csv`;

// every scheduled week (newest first) with its public case
export async function weeks() {
  const { data, error } = await sb.from("weekly_challenges")
    .select("case_id, starts_at, ends_at, cases(id, level, title, story, meta, par)")
    .order("starts_at", { ascending: false }).limit(20);
  if (error) throw error;
  return data;
}

// ---------- Stakeout rooms ----------
// Rooms are opened, started and ended by the `game` function, which checks
// the settings and enforces them; the browser only reads and listens.
async function roomCall(payload) {
  const r = await callGame(payload);
  if (r && r.error) throw new Error(r.error);
  return r;
}
export const createRoom = (settings, caseId) => roomCall({ action: "create_room", settings, case_id: caseId }).then((r) => r.code);
export const startRoom = (code) => roomCall({ action: "start_room", code });
export const endRoom = (code) => roomCall({ action: "end_room", code });
export const spectate = (code) => roomCall({ action: "spectate", code });

export async function getRoom(code) {
  const { data, error } = await sb.from("rooms")
    .select("code, host_id, case_id, status, starts_at, ends_at, settings, winner_id, cases(title, level), winner:players!rooms_winner_id_fkey(name)")
    .eq("code", code.toUpperCase()).maybeSingle();
  if (error) throw error;
  return data;
}

// notebooks a debrief or a spectator may read (the database decides which)
export async function roomNotebooks(code) {
  const { data, error } = await sb.rpc("room_notebooks", { p_code: code });
  if (error) throw error;
  return data;
}

// live room: row changes (lobby -> running -> done), who's in it (presence),
// and players' progress (broadcast: cells run, guesses, status)
export function watchRoom(code, me, { onRoom, onPeople, onProgress }) {
  const channel = sb.channel(`room:${code}`, { config: { presence: { key: user.id }, broadcast: { self: false } } });
  channel
    .on("postgres_changes", { event: "UPDATE", schema: "public", table: "rooms", filter: `code=eq.${code}` },
        (payload) => onRoom(payload.new))
    .on("presence", { event: "sync" }, () => {
      const people = Object.values(channel.presenceState()).map((metas) => metas[0]);
      onPeople(people);
    })
    .on("broadcast", { event: "progress" }, ({ payload }) => onProgress && onProgress(payload))
    .subscribe((status) => {
      if (status === "SUBSCRIBED") channel.track({ ...me, id: user.id });
    });
  return {
    unsub: () => sb.removeChannel(channel),
    send: (progress) => channel.send({ type: "broadcast", event: "progress", payload: { ...progress, id: user.id } }),
  };
}

// ---------- Upload: share a pack by link ----------
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";   // no 0/O or 1/I to misread

export async function sharePack(pack) {
  for (let tries = 0; tries < 5; tries++) {
    const code = Array.from(crypto.getRandomValues(new Uint32Array(8)),
      (n) => CODE_ALPHABET[n % CODE_ALPHABET.length]).join("");
    const { error } = await sb.from("custom_packs").insert({ share_code: code, owner_id: user.id, pack });
    if (!error) return code;
    if (error.code !== "23505") throw error;
  }
  throw new Error("couldn't create a share link, try again");
}
export async function getPack(code) {
  const { data, error } = await sb.rpc("get_custom_pack", { p_code: code });
  if (error) throw error;
  return data;
}

// "N detectives online": everyone on the site shares one presence channel
let lobby = null;
let onlineCount = 1;
export function joinLobby(name) {
  if (lobby) return;
  lobby = sb.channel("lobby", { config: { presence: { key: user.id } } });
  lobby.on("presence", { event: "sync" }, () => {
    onlineCount = Math.max(1, Object.keys(lobby.presenceState()).length);
  });
  lobby.subscribe((status) => {
    if (status === "SUBSCRIBED") lobby.track({ name, at: Date.now() });
  });
}
export function online() {
  return onlineCount;
}
