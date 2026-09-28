// The `game` function: the only place a verdict is checked or a solve is
// recorded. Browsers can read boards, but only this function (running
// with the service role) sees answers and writes solves.
//
//   POST { action: "start",   case_id, room_code? }            -> { game_id }
//   POST { action: "verdict", game_id, answer, stats, notebook, share }
//        wrong -> { correct: false, attempts, hint }
//        right -> { correct: true, elapsed_seconds, steps, attempts, score, explanation }
//
// Time is measured on the server, from the game's start to the right verdict.
// Runs/cells/errors/runtime come from the player's browser; they're clamped to
// sane ranges here, since a notebook can only be counted where it runs.
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
  if (roomCode) {
    const { data: room } = await db.from("rooms").select("case_id, status").eq("code", roomCode).maybeSingle();
    if (!room || room.case_id !== caseId) return json({ error: "that room is for a different case" }, 400);
    if (room.status !== "running") return json({ error: "the host hasn't started this Stakeout yet" }, 400);
  }

  const { data: game, error } = await db.from("games")
    .insert({ player_id: userId, case_id: caseId, room_code: roomCode })
    .select("id, started_at").single();
  if (error) return json({ error: error.message }, 500);
  return json({ game_id: game.id, started_at: game.started_at });
}

async function verdict(userId: string, body: Record<string, unknown>) {
  const { data: game } = await db.from("games").select("*")
    .eq("id", String(body.game_id || "")).eq("player_id", userId).maybeSingle();
  if (!game) return json({ error: "no active game -- open the case again" }, 404);
  if (game.solved_at) return json({ error: "already solved -- start a new case" }, 400);

  const { data: secret } = await db.from("case_secrets").select("*").eq("case_id", game.case_id).single();
  const answer = String(body.answer || "").slice(0, 500);

  if (!checkAnswer(answer, secret)) {
    const wrong = game.wrong + 1;
    await db.from("games").update({ wrong }).eq("id", game.id);
    const hints: string[] = secret.hints;
    return json({ correct: false, attempts: wrong, hint: hints[Math.min(wrong, hints.length) - 1] });
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
    share_in_scout: body.share !== false,
  });
  if (error) return json({ error: error.message }, 500);

  return json({
    correct: true,
    elapsed_seconds: elapsed,
    steps,
    attempts: entry.attempts,
    score: points,
    explanation: secret.description,
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
    if (body.action === "start") return await start(user.id, body);
    if (body.action === "verdict") return await verdict(user.id, body);
    return json({ error: "unknown action" }, 400);
  } catch (err) {
    return json({ error: String((err as Error).message || err) }, 500);
  }
});
