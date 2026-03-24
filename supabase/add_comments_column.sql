-- Run in Supabase → SQL Editor if `clip_reviews` exists but was created without `comments`
-- (older schema) or restores fail with "column comments does not exist".
-- Safe to run multiple times.

alter table public.clip_reviews
  add column if not exists comments jsonb not null default '[]'::jsonb;
