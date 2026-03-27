-- Collaborative reviews via invite codes (run in Supabase SQL Editor after schema.sql).
-- Host generates a code; guests redeem and become clip_review_collaborators; RLS allows
-- SELECT/UPDATE on the host's clip_reviews row for collaborators.
-- Safe to re-run: policies are dropped before recreate.

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------
create or replace function public.normalize_clip_id_for_invite(p_platform text, p_clip_id text)
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

create or replace function public.generate_invite_code_text()
returns text
language plpgsql
as $$
declare
  chars text := '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  out text := '';
  i int;
  pos int;
begin
  for i in 1..8 loop
    pos := 1 + floor(random() * length(chars))::int;
    out := out || substr(chars, pos, 1);
  end loop;
  return out;
end;
$$;

/** True when collaborator row matches clip_reviews row — Dropbox ids may differ only by ?query suffix. */
create or replace function public.clip_ids_match_for_collab(p_platform text, id_a text, id_b text)
returns boolean
language sql
immutable
as $$
  select case
    when p_platform = 'dropbox' then
      public.normalize_clip_id_for_invite('dropbox', coalesce(id_a, ''))
        = public.normalize_clip_id_for_invite('dropbox', coalesce(id_b, ''))
    else coalesce(id_a, '') = coalesce(id_b, '')
  end;
$$;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
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

create table if not exists public.review_invite_codes (
  code text primary key,
  host_user_id uuid not null references auth.users (id) on delete cascade,
  platform text not null,
  clip_id text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz null
);

create index if not exists review_invite_codes_host_clip_idx
  on public.review_invite_codes (host_user_id, platform, clip_id);

-- ---------------------------------------------------------------------------
-- RLS: collaborators (client may SELECT and DELETE own membership; writes via RPC except self-delete)
-- ---------------------------------------------------------------------------
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

-- ---------------------------------------------------------------------------
-- RLS: invite codes (optional client reads; mutations use RPC with SECURITY DEFINER)
-- ---------------------------------------------------------------------------
alter table public.review_invite_codes enable row level security;

drop policy if exists "review_invite_codes_host_all" on public.review_invite_codes;

create policy "review_invite_codes_host_all"
  on public.review_invite_codes for all
  using (auth.uid() = host_user_id)
  with check (auth.uid() = host_user_id);

-- ---------------------------------------------------------------------------
-- clip_reviews: extend SELECT / UPDATE for collaborators
-- ---------------------------------------------------------------------------
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

-- INSERT / DELETE unchanged (host-only policies from original schema remain — recreate if missing)
drop policy if exists "clip_reviews_insert_own" on public.clip_reviews;
create policy "clip_reviews_insert_own"
  on public.clip_reviews for insert
  with check (auth.uid() = user_id);

drop policy if exists "clip_reviews_delete_own" on public.clip_reviews;
create policy "clip_reviews_delete_own"
  on public.clip_reviews for delete
  using (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- RPC: create_review_invite — one active code per host+platform+clip (replaces previous)
-- ---------------------------------------------------------------------------
create or replace function public.create_review_invite(p_platform text, p_clip_id text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := auth.uid();
  norm_id text;
  attempts int := 0;
  new_code text;
begin
  if uid is null then
    return jsonb_build_object('ok', false, 'error', 'not_authenticated');
  end if;

  if p_platform is null or trim(p_platform) = '' or p_clip_id is null or trim(p_clip_id) = '' then
    return jsonb_build_object('ok', false, 'error', 'invalid_clip');
  end if;

  norm_id := public.normalize_clip_id_for_invite(p_platform, p_clip_id);

  if not exists (
    select 1 from public.clip_reviews cr
    where cr.user_id = uid
      and cr.platform = p_platform
      and cr.clip_id = norm_id
  ) then
    return jsonb_build_object('ok', false, 'error', 'no_review_row');
  end if;

  delete from public.review_invite_codes r
  where r.host_user_id = uid
    and r.platform = p_platform
    and r.clip_id = norm_id;

  loop
    attempts := attempts + 1;
    if attempts > 25 then
      return jsonb_build_object('ok', false, 'error', 'code_generation_failed');
    end if;
    new_code := public.generate_invite_code_text();
    begin
      insert into public.review_invite_codes (code, host_user_id, platform, clip_id)
      values (new_code, uid, p_platform, norm_id);
      return jsonb_build_object('ok', true, 'code', new_code);
    exception when unique_violation then
      null;
    end;
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- RPC: redeem_review_invite
-- ---------------------------------------------------------------------------
create or replace function public.redeem_review_invite(p_code text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  norm text := upper(trim(coalesce(p_code, '')));
  inv public.review_invite_codes%rowtype;
  uid uuid := auth.uid();
begin
  if uid is null then
    return jsonb_build_object('ok', false, 'error', 'not_authenticated');
  end if;

  if length(norm) < 4 then
    return jsonb_build_object('ok', false, 'error', 'invalid_code');
  end if;

  select * into inv from public.review_invite_codes r where r.code = norm;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'invalid_code');
  end if;

  if inv.expires_at is not null and inv.expires_at < now() then
    return jsonb_build_object('ok', false, 'error', 'expired');
  end if;

  if inv.host_user_id = uid then
    return jsonb_build_object(
      'ok', true,
      'host_user_id', inv.host_user_id,
      'platform', inv.platform,
      'clip_id', inv.clip_id,
      'is_host', true
    );
  end if;

  insert into public.clip_review_collaborators (host_user_id, platform, clip_id, member_user_id)
  values (inv.host_user_id, inv.platform, inv.clip_id, uid)
  on conflict (host_user_id, platform, clip_id, member_user_id) do nothing;

  return jsonb_build_object(
    'ok', true,
    'host_user_id', inv.host_user_id,
    'platform', inv.platform,
    'clip_id', inv.clip_id,
    'is_host', false
  );
end;
$$;

revoke all on function public.create_review_invite(text, text) from public;
revoke all on function public.redeem_review_invite(text) from public;
grant execute on function public.create_review_invite(text, text) to authenticated;
grant execute on function public.redeem_review_invite(text) to authenticated;
