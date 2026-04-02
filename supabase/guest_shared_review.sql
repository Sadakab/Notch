-- Guest access to shared reviews (no Supabase session). Run after invite_collab.sql.
-- Anyone who knows host UUID + platform + clip_id can read/update — same exposure as share URLs.

create or replace function public.guest_load_shared_review(
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
  norm_id text;
  r record;
begin
  if p_host_user_id is null then
    return jsonb_build_object('ok', false, 'error', 'invalid_host');
  end if;
  if p_platform is null or trim(p_platform) = '' or p_clip_id is null or trim(p_clip_id) = '' then
    return jsonb_build_object('ok', false, 'error', 'invalid_clip');
  end if;

  norm_id := public.normalize_clip_id_for_collab(p_platform, p_clip_id);

  select cr.id, cr.user_id, cr.platform, cr.clip_id, cr.comments, cr.title, cr.thumbnail_url, cr.updated_at
  into r
  from public.clip_reviews cr
  where cr.user_id = p_host_user_id
    and cr.platform = p_platform
    and public.clip_ids_match_for_collab(p_platform, cr.clip_id, norm_id)
  order by cr.updated_at desc
  limit 1;

  if r.id is null then
    return jsonb_build_object('ok', false, 'error', 'no_review');
  end if;

  return jsonb_build_object(
    'ok', true,
    'record', jsonb_build_object(
      'id', r.id,
      'user_id', r.user_id,
      'platform', r.platform,
      'clip_id', r.clip_id,
      'comments', coalesce(r.comments, '[]'::jsonb),
      'title', r.title,
      'thumbnail_url', r.thumbnail_url,
      'updated_at', r.updated_at
    )
  );
end;
$$;

create or replace function public.guest_update_shared_review(
  p_host_user_id uuid,
  p_platform text,
  p_clip_id text,
  p_comments jsonb,
  p_title text,
  p_thumbnail_url text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  norm_id text;
  rid uuid;
  db_clip_id text;
  comments_len int;
begin
  if p_host_user_id is null then
    return jsonb_build_object('ok', false, 'error', 'invalid_host');
  end if;
  if p_platform is null or trim(p_platform) = '' or p_clip_id is null or trim(p_clip_id) = '' then
    return jsonb_build_object('ok', false, 'error', 'invalid_clip');
  end if;
  if p_comments is null or jsonb_typeof(p_comments) <> 'array' then
    return jsonb_build_object('ok', false, 'error', 'invalid_comments');
  end if;

  comments_len := octet_length(p_comments::text);
  if comments_len > 12000000 then
    return jsonb_build_object('ok', false, 'error', 'payload_too_large');
  end if;

  norm_id := public.normalize_clip_id_for_collab(p_platform, p_clip_id);

  select cr.id, cr.clip_id
  into rid, db_clip_id
  from public.clip_reviews cr
  where cr.user_id = p_host_user_id
    and cr.platform = p_platform
    and public.clip_ids_match_for_collab(p_platform, cr.clip_id, norm_id)
  order by cr.updated_at desc
  limit 1;

  if rid is null then
    return jsonb_build_object('ok', false, 'error', 'no_review');
  end if;

  update public.clip_reviews cr
  set
    comments = p_comments,
    title = case
      when p_title is not null and trim(p_title) <> '' then trim(p_title)
      else cr.title
    end,
    thumbnail_url = case
      when p_thumbnail_url is not null and trim(p_thumbnail_url) <> '' then trim(p_thumbnail_url)
      else cr.thumbnail_url
    end,
    updated_at = now()
  where cr.id = rid;

  return jsonb_build_object('ok', true, 'review_id', rid);
end;
$$;

revoke all on function public.guest_load_shared_review(uuid, text, text) from public;
grant execute on function public.guest_load_shared_review(uuid, text, text) to anon;
grant execute on function public.guest_load_shared_review(uuid, text, text) to authenticated;

revoke all on function public.guest_update_shared_review(uuid, text, text, jsonb, text, text) from public;
grant execute on function public.guest_update_shared_review(uuid, text, text, jsonb, text, text) to anon;
grant execute on function public.guest_update_shared_review(uuid, text, text, jsonb, text, text) to authenticated;
