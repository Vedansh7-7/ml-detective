// The `game` function: the only place a verdict is checked, a solve is
// recorded, or a Stakeout room is opened, started or ended. Browsers can
// read boards and rooms, but only this function (running with the service
// role) sees answers and writes those rows.
//
//   POST { action: "start",   case_id, room_code? }            -> { game_id, started_at }
//   POST { action: "verdict", game_id, answer, stats, notebook }
//        wrong -> { correct: false, attempts, hint?, out? }
//        right -> { correct: true, elapsed_seconds, steps, attempts, score, explanation, won? }
//   POST { action: "save_notebook", game_id, notebook }        -> { ok }   (Library, unsolved games)
//   POST { action: "create_room", settings, case_id? }        -> { code }
//   POST { action: "start_room", code }                        -> { ok, case_id, starts_at, ends_at }
//   POST { action: "end_room", code }                          -> { ok }
//   POST { action: "spectate", code }                          -> { ok }
//
// Time is measured on the server. Runs/cells/errors/runtime come from the
// player's browser; they're clamped to sane ranges here.
import { createClient } from "npm:@supabase/supabase-js@2";
import { checkAnswer } from "./answers.js";
import { parFor, score, statsOf } from "./scoring.js";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false },
});

const int = (v: unknown, max: number) => Math.min(max, Math.max(0, Math.floor(Number(v) || 0)));
const num = (v: unknown, max: number) => Math.min(max, Math.max(0, Number(v) || 0));

function cleanNotebook(nb: unknown): string[] | null {
  if (!Array.isArray(nb)) return null;
  return nb.filter((c) => typeof c === "string").slice(0, 60).map((c) => c.slice(0, 20000));
}

// ------------------------------------------------------------ room settings
type Settings = {
  preset: string; case_mode: "pick" | "random" | "mystery" | "upload"; level: string;
  time_limit: number; win: "score" | "race"; hints: "on" | "off" | "after"; hints_after: number;
  lives: number; max_players: number; debrief: boolean; spectators: boolean; pack_code: string | null;
};
const pickFrom = <T>(v: unknown, allowed: readonly T[], fallback: T): T => (allowed.includes(v as T) ? v as T : fallback);

export function cleanSettings(raw: unknown): Settings {
  const s = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const packCode = typeof s.pack_code === "string" && /^[A-Z2-9]{8}$/.test(s.pack_code) ? s.pack_code : null;
  const caseMode = pickFrom(s.case_mode, ["pick", "random", "mystery", "upload"] as const, "pick");
  return {
    preset: pickFrom(s.preset, ["casual", "race", "hardcore", "custom"], "casual"),
    case_mode: caseMode === "upload" && !packCode ? "pick" : caseMode,
    level: pickFrom(s.level, ["any", "easy", "normal", "hard"], "any"),
    time_limit: pickFrom(Number(s.time_limit), [0, 5, 10, 15, 20], 0),
    win: pickFrom(s.win, ["score", "race"] as const, "score"),
    hints: pickFrom(s.hints, ["on", "off", "after"] as const, "on"),
    hints_after: pickFrom(Number(s.hints_after), [1, 2, 3, 5], 3),
    lives: pickFrom(Number(s.lives), [0, 3, 1], 0),
    max_players: Math.min(10, Math.max(2, Math.floor(Number(s.max_players) || 10))),
    debrief: s.debrief !== false,
    spectators: s.spectators === true,
    pack_code: caseMode === "upload" ? packCode : null,
  };
}

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";   // no 0/O or 1/I to misread
const newCode = () => Array.from(crypto.getRandomValues(new Uint32Array(6)),
  (n) => CODE_ALPHABET[n % CODE_ALPHABET.length]).join("");

async function createRoom(userId: string, body: Record<string, unknown>) {
  const { data: player } = await db.from("players").select("id").eq("id", userId).maybeSingle();
  if (!player) return json({ error: "pick a detective name first" }, 400);
  const settings = cleanSettings(body.settings);
  let caseId: string | null = null;
  if (settings.case_mode === "pick") {
    caseId = String(body.case_id || "");
    const { data: kase } = await db.from("cases").select("id, source").eq("id", caseId).maybeSingle();
    if (!kase || kase.source !== "core") return json({ error: "pick one of the archive's cases" }, 400);
  }
  if (settings.case_mode === "upload") {
    const { data: pack } = await db.from("custom_packs").select("share_code").eq("share_code", settings.pack_code).maybeSingle();
    if (!pack) return json({ error: "that uploaded case isn't shared any more" }, 400);
  }
  for (let tries = 0; tries < 5; tries++) {
    const code = newCode();
    const { error } = await db.from("rooms").insert({ code, host_id: userId, case_id: caseId, settings });
    if (!error) return json({ code });
    if (error.code !== "23505") return json({ error: error.message }, 500);
  }
  return json({ error: "couldn't open a room, try again" }, 500);
}

// an uploaded pack becomes a (custom) case the first time a room starts with it
async function registerPackCase(packCode: string): Promise<string | Response> {
  const caseId = `pack_${packCode.toLowerCase()}`;
  const { data: existing } = await db.from("cases").select("id").eq("id", caseId).maybeSingle();
  if (existing) return caseId;
  const { data: row } = await db.from("custom_packs").select("pack").eq("share_code", packCode).maybeSingle();
  const pack = row?.pack as Record<string, any> | undefined;
  const story = pack?.story, secret = pack?.secret;
  if (!story || !secret || !Array.isArray(secret.accepted_answers) || !Array.isArray(secret.hints)) {
    return json({ error: "that uploaded case can't be used in a room" }, 400);
  }
  const level = ["easy", "normal", "hard"].includes(story.level) ? story.level : "normal";
  const { error } = await db.from("cases").insert({
    id: caseId, level, title: String(story.title || "Uploaded case").slice(0, 120), source: "custom",
    story: { title: story.title, level, hook: story.hook ?? null },
  });
  if (error && error.code !== "23505") return json({ error: error.message }, 500);
  await db.from("case_secrets").upsert({
    case_id: caseId, accepted_answers: secret.accepted_answers, target_column: secret.target_column ?? null,
    hints: secret.hints, description: String(secret.description || ""),
  });
  return caseId;
}

async function startRoom(userId: string, body: Record<string, unknown>) {
  const code = String(body.code || "").toUpperCase();
  const { data: room } = await db.from("rooms").select("*").eq("code", code).maybeSingle();
  if (!room) return json({ error: "no room with that code" }, 404);
  if (room.host_id !== userId) return json({ error: "only the host can start the Stakeout" }, 403);
  if (room.status !== "lobby") return json({ error: "this Stakeout has already started" }, 400);
  const settings = cleanSettings(room.settings);

  let caseId: string | null = room.case_id;
  if (settings.case_mode === "random" || settings.case_mode === "mystery") {
    let q = db.from("cases").select("id").eq("source", "core");
    if (settings.level !== "any") q = q.eq("level", settings.level);
    const { data: pool } = await q;
    if (!pool || !pool.length) return json({ error: "no cases to pick from" }, 500);
    caseId = pool[Math.floor(Math.random() * pool.length)].id;
  } else if (settings.case_mode === "upload") {
    const r = await registerPackCase(settings.pack_code!);
    if (r instanceof Response) return r;
    caseId = r;
  }
  const startsAt = new Date(Date.now() + 5000);
  const endsAt = settings.time_limit ? new Date(startsAt.getTime() + settings.time_limit * 60_000) : null;
  const { error } = await db.from("rooms").update({
    case_id: caseId, status: "running", starts_at: startsAt.toISOString(), ends_at: endsAt?.toISOString() ?? null,
  }).eq("code", code).eq("status", "lobby");
  if (error) return json({ error: error.message }, 500);
  return json({ ok: true, case_id: caseId, starts_at: startsAt.toISOString(), ends_at: endsAt?.toISOString() ?? null });
}

async function endRoom(userId: string, body: Record<string, unknown>) {
  const code = String(body.code || "").toUpperCase();
  const { data: room } = await db.from("rooms").select("host_id, status").eq("code", code).maybeSingle();
  if (!room) return json({ error: "no room with that code" }, 404);
  if (room.host_id !== userId) return json({ error: "only the host can end the round" }, 403);
  await db.from("rooms").update({ status: "done", ends_at: new Date().toISOString() }).eq("code", code).neq("status", "done");
  return json({ ok: true });
}

async function spectate(userId: string, body: Record<string, unknown>) {
  const code = String(body.code || "").toUpperCase();
  const { data: room } = await db.from("rooms").select("settings").eq("code", code).maybeSingle();
  if (!room) return json({ error: "no room with that code" }, 404);
  if (!cleanSettings(room.settings).spectators) return json({ error: "this room doesn't allow spectators" }, 403);
  const { data: playing } = await db.from("games").select("id").eq("room_code", code).eq("player_id", userId).limit(1);
  if (playing && playing.length) return json({ error: "you're playing in this room, so you can't watch it too" }, 400);
  await db.from("room_spectators").upsert({ room_code: code, player_id: userId });
  return json({ ok: true });
}

const roundOver = (room: { status: string; ends_at: string | null }) =>
  room.status === "done" || (room.ends_at != null && Date.now() > Date.parse(room.ends_at));

// ------------------------------------------------------------ games
async function start(userId: string, body: Record<string, unknown>) {
  const caseId = String(body.case_id || "");
  const roomCode = body.room_code ? String(body.room_code).toUpperCase() : null;

  const { data: player } = await db.from("players").select("id").eq("id", userId).maybeSingle();
  if (!player) return json({ error: "pick a detective name first" }, 400);

  const { data: kase } = await db.from("cases").select("id, source").eq("id", caseId).maybeSingle();
  if (!kase) return json({ error: "unknown case" }, 404);

  if (kase.source === "weekly") {
    const { data: week } = await db.from("weekly_challenges").select("starts_at, ends_at")
      .eq("case_id", caseId).maybeSingle();
    const now = Date.now();
    if (!week || now < Date.parse(week.starts_at) || now > Date.parse(week.ends_at)) {
      return json({ error: "this weekly case isn't open right now" }, 403);
    }
  }
  if (kase.source === "custom" && !roomCode) return json({ error: "uploaded cases are ranked only inside a Stakeout" }, 400);
  if (roomCode) {
    const { data: room } = await db.from("rooms").select("case_id, status, ends_at, settings").eq("code", roomCode).maybeSingle();
    if (!room || room.case_id !== caseId) return json({ error: "that room is for a different case" }, 400);
    if (room.status === "lobby") return json({ error: "the host hasn't started this Stakeout yet" }, 400);
    if (roundOver(room)) return json({ error: "this round is over" }, 400);
    const { data: spec } = await db.from("room_spectators").select("player_id").eq("room_code", roomCode).eq("player_id", userId).maybeSingle();
    if (spec) return json({ error: "you're watching this room, so you can't play in it" }, 400);
    const { data: others } = await db.from("games").select("player_id").eq("room_code", roomCode);
    const players = new Set((others || []).map((g) => g.player_id));
    if (!players.has(userId) && players.size >= cleanSettings(room.settings).max_players) {
      return json({ error: "this room is full" }, 400);
    }
  }

  const { data: game, error } = await db.from("games")
    .insert({ player_id: userId, case_id: caseId, room_code: roomCode })
    .select("id, started_at").single();
  if (error) return json({ error: error.message }, 500);
  return json({ game_id: game.id, started_at: game.started_at });
}

async function saveNotebook(userId: string, body: Record<string, unknown>) {
  const nb = cleanNotebook(body.notebook);
  if (!nb) return json({ ok: false });
  await db.from("games").update({ notebook: nb, saved_at: new Date().toISOString() })
    .eq("id", String(body.game_id || "")).eq("player_id", userId).is("solved_at", null);
  return json({ ok: true });
}

async function verdict(userId: string, body: Record<string, unknown>) {
  const { data: game } = await db.from("games").select("*")
    .eq("id", String(body.game_id || "")).eq("player_id", userId).maybeSingle();
  if (!game) return json({ error: "no active game -- open the case again" }, 404);
  if (game.solved_at) return json({ error: "already solved -- start a new case" }, 400);

  let room: Record<string, any> | null = null;
  let settings: Settings | null = null;
  if (game.room_code) {
    const { data } = await db.from("rooms").select("*").eq("code", game.room_code).maybeSingle();
    room = data;
    if (room) {
      settings = cleanSettings(room.settings);
      if (roundOver(room)) {
        await db.from("games").update({ notebook: cleanNotebook(body.notebook) }).eq("id", game.id).is("solved_at", null);
        return json({ error: room.winner_id ? "round over: someone already solved it" : "time's up: this round is over", over: true }, 400);
      }
      if (settings.lives && game.wrong >= settings.lives) {
        return json({ error: "you're out of guesses in this round", out: true }, 400);
      }
    }
  }

  const { data: secret } = await db.from("case_secrets").select("*").eq("case_id", game.case_id).single();
  const answer = String(body.answer || "").slice(0, 500);

  if (!checkAnswer(answer, secret)) {
    const wrong = game.wrong + 1;
    const out = !!(settings && settings.lives && wrong >= settings.lives);
    await db.from("games").update({ wrong, ...(out ? { notebook: cleanNotebook(body.notebook) } : {}) }).eq("id", game.id);
    const hints: string[] = secret.hints;
    let hint: string | null = hints[Math.min(wrong, hints.length) - 1];
    if (settings?.hints === "off") hint = null;
    if (settings?.hints === "after" && room?.starts_at &&
        Date.now() - Date.parse(room.starts_at) < settings.hints_after * 60_000) hint = null;
    return json({ correct: false, attempts: wrong, hint, out });
  }

  // correct: close the game first so a double-submit can't record twice
  const { data: closed } = await db.from("games").update({ solved_at: new Date().toISOString() })
    .eq("id", game.id).is("solved_at", null).select("solved_at").maybeSingle();
  if (!closed) return json({ error: "already solved -- start a new case" }, 400);

  const elapsed = Math.round((Date.parse(closed.solved_at) - Date.parse(game.started_at)) / 100) / 10;
  const s = (body.stats || {}) as Record<string, unknown>;
  const steps = int(s.steps, 5000);
  const entry = {
    elapsed_seconds: elapsed,
    steps,
    attempts: game.wrong + 1,
    cells: Math.min(int(s.cells, 500), steps),
    errored_cells: int(s.errored_cells, 500),
    runtime_seconds: num(s.runtime_seconds, elapsed + 5),
  };

  const [{ data: kase }, { data: previous }] = await Promise.all([
    db.from("cases").select("level, par").eq("id", game.case_id).single(),
    db.from("solves").select("elapsed_seconds, steps, attempts, cells, errored_cells, runtime_seconds")
      .eq("case_id", game.case_id),
  ]);
  const solvesForCase = [...(previous || []), entry];
  const par = parFor(kase.level, solvesForCase, kase.par);
  const points = score(statsOf(entry), par);

  const { error } = await db.from("solves").insert({
    game_id: game.id,
    player_id: userId,
    case_id: game.case_id,
    room_code: game.room_code,
    ...entry,
    score: points,
    notebook: cleanNotebook(body.notebook),
    share_in_scout: false,
  });
  if (error) return json({ error: error.message }, 500);

  // Race: the first correct verdict wins and ends the round for everyone
  let won = false;
  if (room && settings?.win === "race") {
    const { data: took } = await db.from("rooms").update({
      winner_id: userId, status: "done", ends_at: new Date().toISOString(),
    }).eq("code", room.code).is("winner_id", null).select("code").maybeSingle();
    won = !!took;
  }

  return json({
    correct: true,
    elapsed_seconds: elapsed,
    steps,
    attempts: entry.attempts,
    score: points,
    explanation: secret.description,
    won,
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  const { data: { user } } = await db.auth.getUser(token);
  if (!user) return json({ error: "sign in first" }, 401);

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: "bad JSON" }, 400); }

  try {
    switch (body.action) {
      case "start": return await start(user.id, body);
      case "verdict": return await verdict(user.id, body);
      case "save_notebook": return await saveNotebook(user.id, body);
      case "create_room": return await createRoom(user.id, body);
      case "start_room": return await startRoom(user.id, body);
      case "end_room": return await endRoom(user.id, body);
      case "spectate": return await spectate(user.id, body);
      default: return json({ error: "unknown action" }, 400);
    }
  } catch (err) {
    return json({ error: String((err as Error).message || err) }, 500);
  }
});
