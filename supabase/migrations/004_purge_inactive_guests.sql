-- Nightly cleanup: guest (anonymous) accounts nobody has used for 45 days
-- are removed, with everything that hangs off them (profile, games,
-- solves, Stakeout rooms, shared packs). "Last active" is the latest of:
-- account created, last sign-in, session refresh (every hour or so while
-- the game is open), game started, case solved.
create extension if not exists pg_cron;

create or replace function public.purge_inactive_guests(p_days int default 45)
returns int language plpgsql security definer set search_path = ''
as $$
declare removed int;
begin
  with last_active as (
    select u.id,
           greatest(u.created_at, coalesce(u.last_sign_in_at, u.created_at),
                    coalesce((select max(greatest(s.updated_at, coalesce(s.refreshed_at, s.updated_at)))
                              from auth.sessions s where s.user_id = u.id), u.created_at),
                    coalesce((select max(g.started_at) from public.games g where g.player_id = u.id), u.created_at),
                    coalesce((select max(v.created_at) from public.solves v where v.player_id = u.id), u.created_at)
           ) as at
    from auth.users u
    where u.is_anonymous
  )
  delete from auth.users u
  using last_active a
  where u.id = a.id and a.at < now() - make_interval(days => p_days);
  get diagnostics removed = row_count;
  return removed;
end $$;
revoke execute on function public.purge_inactive_guests(int) from public, anon, authenticated;

-- 21:30 UTC = 03:00 IST
select cron.schedule('purge-inactive-guests', '30 21 * * *', $$select public.purge_inactive_guests(45)$$);
