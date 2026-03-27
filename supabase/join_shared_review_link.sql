-- Run in Supabase SQL Editor after invite_collab.sql.
-- Lets guests who open a notch.video share link join as collaborators (RLS).

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

revoke all on function public.join_shared_review_link(uuid, text, text) from public;
grant execute on function public.join_shared_review_link(uuid, text, text) to authenticated;
