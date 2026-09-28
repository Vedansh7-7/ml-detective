// Online mode: Supabase session, shared boards, server-checked verdicts,
// Scout and presence. backend.js falls back to local play if this can't
// connect (offline, or guest sign-in unavailable).
import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";
import { SUPABASE_KEY, SUPABASE_URL } from "./config.js";

export const sb = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true },
});

let user = null;

// a guest session (anonymous auth) that survives reloads in this browser
export async function connect() {
  const { data } = await sb.auth.getSession();
  if (data.session) {
    user = data.session.user;
    return user;
  }
  const { data: signed, error } = await sb.auth.signInAnonymously();
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
export async function boardRows({ caseIds = null, roomCode = null, since = null, until = null, source = "core" } = {}) {
  let q = sb.from("board").select("*").order("created_at", { ascending: false }).limit(1000);
  if (source) q = q.eq("source", source);
  q = roomCode ? q.eq("room_code", roomCode) : q.is("room_code", null);
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

export async function scout(caseId) {
  const { data, error } = await sb.rpc("scout", { p_case: caseId });
  if (error) throw error;
  return data;
}

export async function sendFeedback(row) {
  const { error } = await sb.from("feedback").insert({ player_id: user.id, ...row });
  if (error) throw error;
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
