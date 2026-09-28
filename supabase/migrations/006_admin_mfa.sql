-- Admin access needs two factors: the emailed sign-in link *and* a code from
-- an authenticator app. A session that only used the link is aal1; after the
-- code it is aal2. Every admin read and write goes through is_admin(), so
-- checking the level here covers the RLS policies and admin_overview() too.
create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = ''
as $$
  select coalesce(auth.jwt() ->> 'aal', '') = 'aal2'
     and exists (select 1 from public.admins where user_id = auth.uid())
$$;
revoke execute on function public.is_admin() from public, anon;
grant execute on function public.is_admin() to authenticated;
