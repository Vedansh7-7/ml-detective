-- Weekly Challenge storage.
--
-- Weekly cases are dropped by an admin through the `admin` edge function:
-- the public story/meta go into `cases` (source = 'weekly'), the answers into
-- `case_secrets`, the schedule into `weekly_challenges`, and the dataset CSV
-- into this public bucket at cases/weekly/<id>.csv.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('cases', 'cases', true, 10485760, array['text/csv'])
on conflict (id) do nothing;

-- Admins are granted directly in the database (a trigger promotes the
-- owner's account once its email is confirmed). It isn't kept in this
-- repo because it names a personal email address.
