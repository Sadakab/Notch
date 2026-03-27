-- One-time patch: fix collaborator SELECT/UPDATE when clip_reviews.clip_id and
-- clip_review_collaborators.clip_id differ only by Dropbox ?query suffix (or other
-- legacy normalization). Run in Supabase SQL Editor if cloud save fails with RLS.
-- Safe to re-run.

create or replace function public.clip_ids_match_for_collab(p_platform text, id_a text, id_b text)
returns boolean
language sql
immutable
as $$
  select case
    when p_platform = 'dropbox' then
      public.normalize_clip_id_for_collab('dropbox', coalesce(id_a, ''))
        = public.normalize_clip_id_for_collab('dropbox', coalesce(id_b, ''))
    else coalesce(id_a, '') = coalesce(id_b, '')
  end;
$$;

drop policy if exists "clip_reviews_select_own_or_collab" on public.clip_reviews;
create policy "clip_reviews_select_own_or_collab"
  on public.clip_reviews for select
  using (
    auth.uid() = user_id
    or exists (
      select 1
      from public.clip_review_collaborators c
      where c.host_user_id = clip_reviews.user_id
        and c.platform = clip_reviews.platform
        and public.clip_ids_match_for_collab(c.platform, c.clip_id, clip_reviews.clip_id)
        and c.member_user_id = auth.uid()
    )
  );

drop policy if exists "clip_reviews_update_own_or_collab" on public.clip_reviews;
create policy "clip_reviews_update_own_or_collab"
  on public.clip_reviews for update
  using (
    auth.uid() = user_id
    or exists (
      select 1
      from public.clip_review_collaborators c
      where c.host_user_id = clip_reviews.user_id
        and c.platform = clip_reviews.platform
        and public.clip_ids_match_for_collab(c.platform, c.clip_id, clip_reviews.clip_id)
        and c.member_user_id = auth.uid()
    )
  )
  with check (
    auth.uid() = user_id
    or exists (
      select 1
      from public.clip_review_collaborators c
      where c.host_user_id = clip_reviews.user_id
        and c.platform = clip_reviews.platform
        and public.clip_ids_match_for_collab(c.platform, c.clip_id, clip_reviews.clip_id)
        and c.member_user_id = auth.uid()
    )
  );
