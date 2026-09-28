-- Waitlist (landing page) + the admin board's read access.

create table public.waitlist (
  id            bigint generated always as identity primary key,
  name          text not null check (char_length(name) between 1 and 80),
  email         text not null check (email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$' and char_length(email) <= 200),
  role          text not null check (role in ('educator', 'student', 'company', 'other')),
  organization  text check (char_length(organization) <= 120),
  use_case      text check (char_length(use_case) <= 1000),
  source        text check (char_length(source) <= 200),
  consent       boolean not null default false,
  created_at    timestamptz not null default now()
);
create unique index waitlist_email_idx on public.waitlist (lower(email));
alter table public.waitlist enable row level security;

-- anyone with a (captcha-checked) session can join; only admins can read
create policy "join the waitlist" on public.waitlist for insert to authenticated with check (true);
create policy "admins read the waitlist" on public.waitlist for select to authenticated
  using ((select public.is_admin()));
create policy "admins read feedback" on public.feedback for select to authenticated
  using ((select public.is_admin()));

-- One call for the admin board's numbers. Refuses anyone who isn't an admin.
create or replace function public.admin_overview()
returns jsonb language plpgsql stable security definer set search_path = ''
as $$
declare out jsonb;
begin
  if not public.is_admin() then
    raise exception 'admins only' using errcode = '42501';
  end if;
  select jsonb_build_object(
    'players',        (select count(*) from public.players),
    'players_7d',     (select count(*) from public.players where created_at > now() - interval '7 days'),
    'guests',         (select count(*) from auth.users where is_anonymous),
    'active_7d',      (select count(distinct player_id) from public.games where started_at > now() - interval '7 days'),
    'games_7d',       (select count(*) from public.games where started_at > now() - interval '7 days'),
    'solves',         (select count(*) from public.solves),
    'solves_7d',      (select count(*) from public.solves where created_at > now() - interval '7 days'),
    'rooms_7d',       (select count(*) from public.rooms where created_at > now() - interval '7 days'),
    'shared_packs',   (select count(*) from public.custom_packs),
    'feedback',       (select count(*) from public.feedback),
    'waitlist',       (select count(*) from public.waitlist),
    'waitlist_7d',    (select count(*) from public.waitlist where created_at > now() - interval '7 days'),
    'daily', (select coalesce(jsonb_agg(d order by d->>'day'), '[]'::jsonb) from (
        select jsonb_build_object(
                 'day', day::date,
                 'new_players', (select count(*) from public.players p where p.created_at::date = day::date),
                 'games', (select count(*) from public.games g where g.started_at::date = day::date),
                 'solves', (select count(*) from public.solves s where s.created_at::date = day::date)) as d
        from generate_series(current_date - 13, current_date, interval '1 day') as day) days),
    'top_cases', (select coalesce(jsonb_agg(t), '[]'::jsonb) from (
        select c.title, c.level, c.source, count(s.id) as solves,
               count(distinct g.player_id) as players_tried
        from public.cases c
        left join public.games g on g.case_id = c.id
        left join public.solves s on s.game_id = g.id
        group by c.id order by count(s.id) desc, count(distinct g.player_id) desc limit 20) t),
    'recent_solves', (select coalesce(jsonb_agg(r), '[]'::jsonb) from (
        select p.name as player, c.title, s.score, s.elapsed_seconds, s.attempts, s.room_code, s.created_at
        from public.solves s join public.players p on p.id = s.player_id join public.cases c on c.id = s.case_id
        order by s.created_at desc limit 25) r)
  ) into out;
  return out;
end $$;
revoke execute on function public.admin_overview() from public, anon;
grant execute on function public.admin_overview() to authenticated;
