-- ML Detective: core schema.
--
-- Trust model: browsers use the public (publishable) key and act as an
-- anonymous-or-signed-in auth user. They can read boards and write only
-- their own profile/rooms/feedback. Anything that decides a score --
-- checking a verdict, timing a game, recording a solve -- happens in the
-- `game` edge function with the service role. Answers (case_secrets) are
-- never readable from a browser.

-- ---------------------------------------------------------------- players
create table public.players (
  id          uuid primary key references auth.users (id) on delete cascade,
  name        text not null check (char_length(name) between 1 and 24),
  created_at  timestamptz not null default now()
);

-- ------------------------------------------------------------------ cases
create table public.cases (
  id          text primary key check (id ~ '^[a-z0-9_]{3,60}$'),
  level       text not null check (level in ('easy', 'normal', 'hard')),
  title       text not null,
  source      text not null default 'core' check (source in ('core', 'weekly')),
  par         jsonb,                 -- optional per-case par override
  story       jsonb,                 -- public story + meta for cases not shipped in the site bundle
  meta        jsonb,
  created_at  timestamptz not null default now()
);

create table public.case_secrets (
  case_id           text primary key references public.cases (id) on delete cascade,
  accepted_answers  text[] not null,
  target_column     text,
  hints             text[] not null,
  description       text not null
);

create table public.weekly_challenges (
  case_id    text primary key references public.cases (id) on delete cascade,
  starts_at  timestamptz not null,
  ends_at    timestamptz not null,
  check (ends_at > starts_at)
);

-- ------------------------------------------------------------ rooms (Stakeout)
create table public.rooms (
  code        text primary key check (code ~ '^[A-Z2-9]{6}$'),
  host_id     uuid not null references public.players (id) on delete cascade,
  case_id     text not null references public.cases (id),
  status      text not null default 'lobby' check (status in ('lobby', 'running', 'done')),
  starts_at   timestamptz,
  created_at  timestamptz not null default now()
);

-- ------------------------------------------------------ games + solves
-- A game is opened by the edge function when a player starts a case; its
-- server-side start time is what the solve's time is measured from.
create table public.games (
  id          uuid primary key default gen_random_uuid(),
  player_id   uuid not null references public.players (id) on delete cascade,
  case_id     text not null references public.cases (id),
  room_code   text references public.rooms (code) on delete set null,
  started_at  timestamptz not null default now(),
  wrong       int not null default 0,
  solved_at   timestamptz
);

create table public.solves (
  id               bigint generated always as identity primary key,
  game_id          uuid unique references public.games (id) on delete set null,
  player_id        uuid not null references public.players (id) on delete cascade,
  case_id          text not null references public.cases (id),
  room_code        text references public.rooms (code) on delete set null,
  elapsed_seconds  real not null,
  steps            int not null,
  attempts         int not null,
  cells            int not null,
  errored_cells    int not null,
  runtime_seconds  real not null,
  score            int not null,
  notebook         jsonb,            -- cells' code, for Scout
  share_in_scout   boolean not null default true,
  created_at       timestamptz not null default now()
);
create index solves_case_idx on public.solves (case_id, score desc);
create index solves_room_idx on public.solves (room_code) where room_code is not null;

create table public.feedback (
  id          bigint generated always as identity primary key,
  player_id   uuid references public.players (id) on delete set null,
  case_id     text,
  rating      int check (rating between 1 and 5),
  text        text check (char_length(text) <= 4000),
  created_at  timestamptz not null default now()
);

create table public.admins (
  user_id  uuid primary key references auth.users (id) on delete cascade
);

-- ------------------------------------------------------------------ helpers
create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = ''
as $$ select exists (select 1 from public.admins where user_id = auth.uid()) $$;
-- tells a signed-in user whether *they* are an admin; RLS policies below call it
revoke execute on function public.is_admin() from public, anon;
grant execute on function public.is_admin() to authenticated;

-- ---------------------------------------------------------------- security
alter table public.players           enable row level security;
alter table public.cases             enable row level security;
alter table public.case_secrets      enable row level security;   -- no policies: service role only
alter table public.weekly_challenges enable row level security;
alter table public.rooms             enable row level security;
alter table public.games             enable row level security;   -- no policies: service role only
alter table public.solves            enable row level security;
alter table public.feedback          enable row level security;
alter table public.admins            enable row level security;   -- no policies: service role only

create policy "names are public"      on public.players for select using (true);
create policy "claim own profile"     on public.players for insert to authenticated with check (id = (select auth.uid()));
create policy "rename own profile"    on public.players for update to authenticated
  using (id = (select auth.uid())) with check (id = (select auth.uid()));

create policy "cases are public"      on public.cases for select using (true);
create policy "admins manage cases"   on public.cases for all to authenticated
  using ((select public.is_admin())) with check ((select public.is_admin()));

create policy "weekly is public"      on public.weekly_challenges for select using (true);
create policy "admins schedule weeks" on public.weekly_challenges for all to authenticated
  using ((select public.is_admin())) with check ((select public.is_admin()));

create policy "rooms are public"      on public.rooms for select using (true);
create policy "host opens room"       on public.rooms for insert to authenticated with check (host_id = (select auth.uid()));
create policy "host runs room"        on public.rooms for update to authenticated
  using (host_id = (select auth.uid())) with check (host_id = (select auth.uid()));

-- boards: every solve row is public, but the notebook column is not
create policy "solves are public"     on public.solves for select using (true);
revoke select on public.solves from anon, authenticated;
grant select (id, player_id, case_id, room_code, elapsed_seconds, steps, attempts, cells,
              errored_cells, runtime_seconds, score, share_in_scout, created_at)
  on public.solves to anon, authenticated;
create policy "hide own notebook"     on public.solves for update to authenticated
  using (player_id = (select auth.uid())) with check (player_id = (select auth.uid()));
revoke update on public.solves from anon, authenticated;
grant update (share_in_scout) on public.solves to authenticated;

create policy "send feedback"         on public.feedback for insert to authenticated
  with check (player_id = (select auth.uid()));

-- the board view the site reads (player names joined in)
create view public.board with (security_invoker = true) as
  select s.id, s.case_id, s.room_code, s.elapsed_seconds, s.steps, s.attempts, s.cells,
         s.errored_cells, s.runtime_seconds, s.score, s.created_at,
         p.name as player, c.level, c.title as story_title, c.source, c.par
  from public.solves s
  join public.players p on p.id = s.player_id
  join public.cases c on c.id = s.case_id;
grant select on public.board to anon, authenticated;

-- Scout: other detectives' notebooks for a case, only once you've solved it yourself
create or replace function public.scout(p_case text)
returns table (solve_id bigint, player text, score int, elapsed_seconds real, steps int, attempts int,
               cells int, errored_cells int, runtime_seconds real, notebook jsonb, created_at timestamptz)
language sql stable security definer set search_path = ''
as $$
  select s.id, p.name, s.score, s.elapsed_seconds, s.steps, s.attempts, s.cells, s.errored_cells,
         s.runtime_seconds, s.notebook, s.created_at
  from public.solves s
  join public.players p on p.id = s.player_id
  where s.case_id = p_case
    and s.share_in_scout
    and s.notebook is not null
    and exists (select 1 from public.solves mine
                where mine.case_id = p_case and mine.player_id = auth.uid())
  order by s.score desc
  limit 30
$$;
revoke execute on function public.scout(text) from public, anon;
grant execute on function public.scout(text) to authenticated;

-- Stakeout: room status changes (lobby -> running) stream to players.
-- solves is deliberately NOT published: realtime rows would carry the
-- notebook column; room boards poll the `board` view instead.
alter publication supabase_realtime add table public.rooms;
