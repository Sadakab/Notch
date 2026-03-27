-- Run in Supabase SQL Editor after invite_collab.sql / collab functions exist.
-- When a host deletes their clip_reviews row, remove all collaborator memberships
-- for that review so nothing remains in clip_review_collaborators.
--
-- Uses clip_ids_match_for_collab so Dropbox paths with/without ?query line up.

create or replace function public.clip_reviews_after_delete_cleanup_collaborators()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from public.clip_review_collaborators c
  where c.host_user_id = old.user_id
    and c.platform = old.platform
    and public.clip_ids_match_for_collab(c.platform, c.clip_id, old.clip_id);
  return null;
end;
$$;

drop trigger if exists clip_reviews_cleanup_collaborators_after_delete on public.clip_reviews;
create trigger clip_reviews_cleanup_collaborators_after_delete
  after delete on public.clip_reviews
  for each row
  execute function public.clip_reviews_after_delete_cleanup_collaborators();
