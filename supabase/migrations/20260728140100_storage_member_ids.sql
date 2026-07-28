insert into storage.buckets (id, name, public)
values ('member-ids', 'member-ids', false)
on conflict (id) do nothing;

-- Path convention: {club_id}/{member_id}/front.{ext} and
-- {club_id}/{member_id}/back.{ext} — a stable path per member/side, so a
-- re-upload (client passes upsert:true) replaces the old object instead of
-- accumulating orphans. Unlike the signatures bucket (append-only legal
-- record), ID photos are correctable, hence the UPDATE policy below.
create policy member_ids_select on storage.objects for select to authenticated
  using (
    bucket_id = 'member-ids'
    and (storage.foldername(name))[1]::uuid in (select my_club_ids())
  );

create policy member_ids_insert on storage.objects for insert to authenticated
  with check (
    bucket_id = 'member-ids'
    and (storage.foldername(name))[1]::uuid in (select my_club_ids())
  );

create policy member_ids_update on storage.objects for update to authenticated
  using (
    bucket_id = 'member-ids'
    and (storage.foldername(name))[1]::uuid in (select my_club_ids())
  )
  with check (
    bucket_id = 'member-ids'
    and (storage.foldername(name))[1]::uuid in (select my_club_ids())
  );
