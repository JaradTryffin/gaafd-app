insert into storage.buckets (id, name, public)
values ('signatures', 'signatures', false)
on conflict (id) do nothing;

-- Path convention: {club_id}/{member_id}/{signed_contract_id}.png
-- storage.foldername(name) splits the object path into its folder
-- segments; [1] is the first one, i.e. the club id.
create policy signatures_select on storage.objects for select to authenticated
  using (
    bucket_id = 'signatures'
    and (storage.foldername(name))[1]::uuid in (select my_club_ids())
  );

create policy signatures_insert on storage.objects for insert to authenticated
  with check (
    bucket_id = 'signatures'
    and (storage.foldername(name))[1]::uuid in (select my_club_ids())
  );
