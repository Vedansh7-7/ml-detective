// The `admin` function: publishing a Weekly Challenge case.
//
//   POST { action: "drop_weekly", case: { meta, secret, story, svg }, csv, starts_at, ends_at }
//
// The pack has already been screened and generated in the admin's browser
// (the same story_ingest checks the desktop app uses). This stores it:
// public story/meta -> cases, answers -> case_secrets, dataset -> storage,
// schedule -> weekly_challenges. Only accounts listed in `admins` may call it.
import { createClient } from "npm:@supabase/supabase-js@2";

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

const LEVELS = ["easy", "normal", "hard"];
const MAX_CSV_BYTES = 5 * 1024 * 1024;

function problemsWith(c: any, csv: unknown, startsAt: number, endsAt: number): string[] {
  const p: string[] = [];
  const id = c?.story?.id;
  if (typeof id !== "string" || !/^[a-z0-9_]{3,60}$/.test(id)) p.push("case id must be 3-60 lowercase letters, digits or _");
  if (!LEVELS.includes(c?.story?.level)) p.push("level must be easy, normal or hard");
  if (typeof c?.story?.title !== "string" || !c.story.title.trim()) p.push("story title is missing");
  if (!Array.isArray(c?.secret?.accepted_answers) || c.secret.accepted_answers.length < 3) p.push("need at least 3 accepted answers");
  if (!Array.isArray(c?.secret?.hints) || c.secret.hints.length !== 3) p.push("need exactly 3 hints");
  if (typeof c?.secret?.description !== "string") p.push("secret description is missing");
  if (typeof c?.svg !== "string" || !c.svg.trim().startsWith("<svg")) p.push("doodle SVG is missing");
  if (typeof csv !== "string" || !csv.includes("\n")) p.push("the dataset CSV is missing");
  else if (new TextEncoder().encode(csv).length > MAX_CSV_BYTES) p.push("the dataset is over 5 MB");
  if (!Number.isFinite(startsAt) || !Number.isFinite(endsAt) || endsAt <= startsAt) p.push("the week must end after it starts");
  return p;
}

async function dropWeekly(body: Record<string, any>) {
  const c = body.case;
  const startsAt = Date.parse(body.starts_at), endsAt = Date.parse(body.ends_at);
  const problems = problemsWith(c, body.csv, startsAt, endsAt);
  if (problems.length) return json({ error: problems.join("; ") }, 400);

  const id = c.story.id;
  const { data: existing } = await db.from("cases").select("id").eq("id", id).maybeSingle();
  if (existing) return json({ error: `a case with id '${id}' already exists -- give the pack a new id` }, 409);

  const { data: clash } = await db.from("weekly_challenges").select("case_id")
    .lt("starts_at", new Date(endsAt).toISOString()).gt("ends_at", new Date(startsAt).toISOString());
  if (clash && clash.length) return json({ error: `that week overlaps the weekly case '${clash[0].case_id}'` }, 409);

  const upload = await db.storage.from("cases").upload(`weekly/${id}.csv`,
    new Blob([body.csv], { type: "text/csv" }), { contentType: "text/csv", upsert: false });
  if (upload.error) return json({ error: `storing the dataset failed: ${upload.error.message}` }, 500);

  const story = { ...c.story, doodle_svg: c.svg };
  const steps = [
    () => db.from("cases").insert({ id, level: c.story.level, title: c.story.title, source: "weekly",
                                    story, meta: c.meta, par: c.par ?? null }),
    () => db.from("case_secrets").insert({ case_id: id, accepted_answers: c.secret.accepted_answers,
                                           target_column: c.secret.target_column, hints: c.secret.hints,
                                           description: c.secret.description }),
    () => db.from("weekly_challenges").insert({ case_id: id, starts_at: new Date(startsAt).toISOString(),
                                                ends_at: new Date(endsAt).toISOString() }),
  ];
  for (const step of steps) {
    const { error } = await step();
    if (error) {
      // undo what landed so a retry starts clean
      await db.from("cases").delete().eq("id", id);
      await db.storage.from("cases").remove([`weekly/${id}.csv`]);
      return json({ error: error.message }, 500);
    }
  }
  return json({ ok: true, case_id: id, starts_at: new Date(startsAt).toISOString(), ends_at: new Date(endsAt).toISOString() });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  const { data: { user } } = await db.auth.getUser(token);
  if (!user) return json({ error: "sign in first" }, 401);
  const { data: admin } = await db.from("admins").select("user_id").eq("user_id", user.id).maybeSingle();
  if (!admin) return json({ error: "this account isn't an admin" }, 403);

  let body: Record<string, any>;
  try { body = await req.json(); } catch { return json({ error: "bad JSON" }, 400); }
  try {
    if (body.action === "drop_weekly") return await dropWeekly(body);
    return json({ error: "unknown action" }, 400);
  } catch (err) {
    return json({ error: String((err as Error).message || err) }, 500);
  }
});
