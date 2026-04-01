-- Public display names for reaction hovers and collaboration UI.
-- Run after invite_collab.sql (uses clip_reviews + clip_review_collaborators + clip_ids_match_for_collab).

create table if not exists public.user_public_profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text not null default '',
  updated_at timestamptz not null default now()
);

create index if not exists user_public_profiles_updated_idx
  on public.user_public_profiles (updated_at desc);

alter table public.user_public_profiles enable row level security;

drop policy if exists "user_public_profiles_select_collab" on public.user_public_profiles;
create policy "user_public_profiles_select_collab"
  on public.user_public_profiles for select
  using (
    auth.uid() = id
    or exists (
      select 1
      from public.clip_reviews cr
      where (
        cr.user_id = auth.uid()
        or exists (
          select 1
          from public.clip_review_collaborators c
          where c.host_user_id = cr.user_id
            and c.platform = cr.platform
            and public.clip_ids_match_for_collab(c.platform, c.clip_id, cr.clip_id)
            and c.member_user_id = auth.uid()
        )
      )
      and (
        cr.user_id = user_public_profiles.id
        or exists (
          select 1
          from public.clip_review_collaborators c2
          where c2.host_user_id = cr.user_id
            and c2.platform = cr.platform
            and public.clip_ids_match_for_collab(c2.platform, c2.clip_id, cr.clip_id)
            and c2.member_user_id = user_public_profiles.id
        )
      )
    )
  );

drop policy if exists "user_public_profiles_insert_own" on public.user_public_profiles;
create policy "user_public_profiles_insert_own"
  on public.user_public_profiles for insert
  with check (auth.uid() = id);

drop policy if exists "user_public_profiles_update_own" on public.user_public_profiles;
create policy "user_public_profiles_update_own"
  on public.user_public_profiles for update
  using (auth.uid() = id)
  with check (auth.uid() = id);

grant select, insert, update on public.user_public_profiles to authenticated;
