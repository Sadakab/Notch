-- Shared review collaborators for notch.video links (run after schema.sql).
-- Safe to re-run: policies/functions are dropped before recreate.

create or replace function public.normalize_clip_id_for_collab(p_platform text, p_clip_id text)
returns text
language sql
immutable
as $$
  select case
    when p_platform = 'dropbox'
      and p_clip_id is not null
      and position('?' in p_clip_id) > 0
    then left(p_clip_id, position('?' in p_clip_id) - 1)
    else coalesce(p_clip_id, '')
  end;
$$;

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

create table if not exists public.clip_review_collaborators (
  id uuid primary key default gen_random_uuid(),
  host_user_id uuid not null references auth.users (id) on delete cascade,
  platform text not null,
  clip_id text not null,
  member_user_id uuid not null references auth.users (id) on delete cascade,
  joined_at timestamptz not null default now(),
  constraint clip_review_collaborators_unique_member unique (host_user_id, platform, clip_id, member_user_id)
);

create index if not exists clip_review_collaborators_member_idx
  on public.clip_review_collaborators (member_user_id);

create index if not exists clip_review_collaborators_host_clip_idx
  on public.clip_review_collaborators (host_user_id, platform, clip_id);

drop table if exists public.review_invite_codes;

alter table public.clip_review_collaborators enable row level security;

drop policy if exists "clip_review_collaborators_select" on public.clip_review_collaborators;
create policy "clip_review_collaborators_select"
  on public.clip_review_collaborators for select
  using (
    auth.uid() = host_user_id
    or auth.uid() = member_user_id
  );

drop policy if exists "clip_review_collaborators_delete" on public.clip_review_collaborators;
create policy "clip_review_collaborators_delete"
  on public.clip_review_collaborators for delete
  using (
    auth.uid() = host_user_id
    or auth.uid() = member_user_id
  );

drop policy if exists "clip_reviews_select_own" on public.clip_reviews;
drop policy if exists "clip_reviews_update_own" on public.clip_reviews;

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

drop policy if exists "clip_reviews_insert_own" on public.clip_reviews;
create policy "clip_reviews_insert_own"
  on public.clip_reviews for insert
  with check (auth.uid() = user_id);

drop policy if exists "clip_reviews_delete_own" on public.clip_reviews;
create policy "clip_reviews_delete_own"
  on public.clip_reviews for delete
  using (auth.uid() = user_id);

create or replace function public.join_shared_review_link(
  p_host_user_id uuid,
  p_platform text,
  p_clip_id text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := auth.uid();
  norm_id text;
begin
  if uid is null then
    return jsonb_build_object('ok', false, 'error', 'not_authenticated');
  end if;
  if p_host_user_id is null then
    return jsonb_build_object('ok', false, 'error', 'invalid_host');
  end if;
  if p_platform is null or trim(p_platform) = '' or p_clip_id is null or trim(p_clip_id) = '' then
    return jsonb_build_object('ok', false, 'error', 'invalid_clip');
  end if;
  if p_host_user_id = uid then
    return jsonb_build_object(
      'ok', true,
      'host_user_id', p_host_user_id,
      'platform', p_platform,
      'clip_id', public.normalize_clip_id_for_collab(p_platform, p_clip_id),
      'is_host', true
    );
  end if;

  norm_id := public.normalize_clip_id_for_collab(p_platform, p_clip_id);

  if not exists (
    select 1
    from public.clip_reviews cr
    where cr.user_id = p_host_user_id
      and cr.platform = p_platform
      and public.clip_ids_match_for_collab(p_platform, cr.clip_id, norm_id)
  ) then
    return jsonb_build_object('ok', false, 'error', 'no_review');
  end if;

  insert into public.clip_review_collaborators (host_user_id, platform, clip_id, member_user_id)
  values (p_host_user_id, p_platform, norm_id, uid)
  on conflict (host_user_id, platform, clip_id, member_user_id) do nothing;

  return jsonb_build_object(
    'ok', true,
    'host_user_id', p_host_user_id,
    'platform', p_platform,
    'clip_id', norm_id,
    'is_host', false
  );
end;
$$;

drop function if exists public.create_review_invite(text, text);
drop function if exists public.redeem_review_invite(text);

revoke all on function public.join_shared_review_link(uuid, text, text) from public;
grant execute on function public.join_shared_review_link(uuid, text, text) to authenticated;
