-- Stakeout room settings, spectators and debrief; the player's Library.
--
-- Rooms are now created and started by the `game` function, which
-- validates the settings and enforces them (time limit, win condition,
-- hints, guesses, player cap). Browsers can still read rooms.

-- ------------------------------------------------------------ rooms
alter table public.rooms
  alter column case_id drop not null,          -- random / mystery / uploaded: chosen at start
  add column settings  jsonb not null default '{}'::jsonb
                       check (octet_length(settings::text) < 4000),
  add column ends_at   timestamptz,            -- time limit, race finish, or host ended it
  add column winner_id uuid references public.players (id) on delete set null;

drop policy if exists "host opens room" on public.rooms;
drop policy if exists "host runs room" on public.rooms;

-- people watching a room (they can't play in it)
create table public.room_spectators (
  room_code  text not null references public.rooms (code) on delete cascade,
  player_id  uuid not null references public.players (id) on delete cascade,
  primary key (room_code, player_id)
);
alter table public.room_spectators enable row level security;   -- no policies: service role only

-- an uploaded case can be a room's case (its answers already travel with the shared pack)
alter table public.cases drop constraint if exists cases_source_check;
alter table public.cases add constraint cases_source_check check (source in ('core', 'weekly', 'custom'));

-- ------------------------------------------------------------ Library
-- the notebook of a game you left unsolved (solved games keep theirs on the solve)
alter table public.games
  add column notebook jsonb check (notebook is null or octet_length(notebook::text) < 400000),
  add column saved_at timestamptz;

-- your own sessions, newest first: only ever your rows
create or replace function public.my_library()
returns table (game_id uuid, case_id text, title text, level text, source text, room_code text,
               started_at timestamptz, solved_at timestamptz, wrong int, score int,
               elapsed_seconds real, steps int, notebook jsonb)
language sql stable security definer set search_path = ''
as $$
  select g.id, g.case_id, c.title, c.level, c.source, g.room_code, g.started_at, g.solved_at, g.wrong,
         s.score, s.elapsed_seconds, s.steps, coalesce(s.notebook, g.notebook)
  from public.games g
  join public.cases c on c.id = g.case_id
  left join public.solves s on s.game_id = g.id
  where g.player_id = auth.uid()
  order by g.started_at desc
  limit 200
$$;
revoke execute on function public.my_library() from public, anon;
grant execute on function public.my_library() to authenticated;

-- ------------------------------------------------------------ room notebooks
-- Spectators see a player's notebook once that player has finished (solved,
-- out of guesses, or the round is over). Players see everyone's once the
-- round is over, if the room has the debrief on.
create or replace function public.room_notebooks(p_code text)
returns table (player text, solved boolean, finished boolean, score int, elapsed_seconds real,
               steps int, attempts int, notebook jsonb)
language sql stable security definer set search_path = ''
as $$
  with r as (
    select code, status, ends_at, settings from public.rooms where code = upper(p_code)
  ), who as (
    select
      exists (select 1 from public.room_spectators sp where sp.room_code = (select code from r)
              and sp.player_id = auth.uid()) as spectator,
      exists (select 1 from public.games g where g.room_code = (select code from r)
              and g.player_id = auth.uid()) as player,
      (select status = 'done' or (ends_at is not null and ends_at <= now()) from r) as over,
      coalesce((select (settings->>'debrief')::boolean from r), false) as debrief,
      coalesce((select nullif(settings->>'lives', '')::int from r), 0) as lives
  ), latest as (
    select distinct on (g.player_id) g.*
    from public.games g
    where g.room_code = (select code from r)
    order by g.player_id, g.started_at desc
  )
  select p.name,
         s.id is not null,
         (s.id is not null or ((select lives from who) > 0 and l.wrong >= (select lives from who))
          or (select over from who)),
         s.score, s.elapsed_seconds, s.steps, coalesce(s.attempts, l.wrong),
         coalesce(s.notebook, l.notebook)
  from latest l
  join public.players p on p.id = l.player_id
  left join public.solves s on s.game_id = l.id
  where ((select spectator from who)
         and (s.id is not null or ((select lives from who) > 0 and l.wrong >= (select lives from who))
              or (select over from who)))
     or ((select player from who) and (select debrief from who) and (select over from who))
  order by s.score desc nulls last, p.name
$$;
revoke execute on function public.room_notebooks(text) from public, anon;
grant execute on function public.room_notebooks(text) to authenticated;

-- Scout is retired (replaced by the Library); its function goes too
drop function if exists public.scout(text);
