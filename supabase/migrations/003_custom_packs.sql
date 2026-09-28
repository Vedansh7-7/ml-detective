-- Uploaded (custom) cases shared by link.
--
-- A shared pack includes its own answers (it's unranked, and the player
-- who shares it wrote it). Rows can't be listed: there is no select
-- policy, and get_custom_pack() only returns the one pack whose code you
-- already have.
create table public.custom_packs (
  share_code  text primary key check (share_code ~ '^[A-Z2-9]{8}$'),
  owner_id    uuid not null references public.players (id) on delete cascade,
  pack        jsonb not null check (octet_length(pack::text) < 200000),
  created_at  timestamptz not null default now()
);
alter table public.custom_packs enable row level security;

create policy "share own pack" on public.custom_packs for insert to authenticated
  with check (owner_id = (select auth.uid()));

create or replace function public.get_custom_pack(p_code text)
returns jsonb language sql stable security definer set search_path = ''
as $$ select pack from public.custom_packs where share_code = upper(p_code) $$;
revoke execute on function public.get_custom_pack(text) from public;
grant execute on function public.get_custom_pack(text) to anon, authenticated;
