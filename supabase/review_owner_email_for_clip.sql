-- Run in Supabase SQL Editor.
-- Returns the canonical owner email for a review when the caller is allowed to view that review.

create or replace function public.review_owner_email_for_clip(
  p_host_user_id uuid,
  p_platform text,
  p_clip_id text
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := auth.uid();
  norm_id text;
  owner_email text;
begin
  if uid is null then
    return null;
  end if;
  if p_host_user_id is null then
    return null;
  end if;
  if p_platform is null or trim(p_platform) = '' or p_clip_id is null or trim(p_clip_id) = '' then
    return null;
  end if;

  norm_id := public.normalize_clip_id_for_collab(p_platform, p_clip_id);

  if not exists (
    select 1
    from public.clip_reviews cr
    where cr.user_id = p_host_user_id
      and cr.platform = p_platform
      and public.clip_ids_match_for_collab(p_platform, cr.clip_id, norm_id)
  ) then
    return null;
  end if;

  if uid <> p_host_user_id and not exists (
    select 1
    from public.clip_review_collaborators c
    where c.host_user_id = p_host_user_id
      and c.platform = p_platform
      and public.clip_ids_match_for_collab(c.platform, c.clip_id, norm_id)
      and c.member_user_id = uid
  ) then
    return null;
  end if;

  select u.email
  into owner_email
  from auth.users u
  where u.id = p_host_user_id
  limit 1;

  return nullif(trim(coalesce(owner_email, '')), '');
end;
$$;

revoke all on function public.review_owner_email_for_clip(uuid, text, text) from public;
grant execute on function public.review_owner_email_for_clip(uuid, text, text) to authenticated;
