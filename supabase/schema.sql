-- Run this in Supabase → SQL Editor (new project, blank DB).
-- Enables per-user video reviews with Row Level Security.

create extension if not exists "pgcrypto";

create table public.clip_reviews (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  platform text not null,
  clip_id text not null,
  comments jsonb not null default '[]'::jsonb,
  title text,
  thumbnail_url text,
  updated_at timestamptz not null default now(),
  constraint clip_reviews_user_clip unique (user_id, platform, clip_id)
);

create index clip_reviews_user_updated_idx
  on public.clip_reviews (user_id, updated_at desc);

alter table public.clip_reviews enable row level security;

create policy "clip_reviews_select_own"
  on public.clip_reviews for select
  using (auth.uid() = user_id);

create policy "clip_reviews_insert_own"
  on public.clip_reviews for insert
  with check (auth.uid() = user_id);

create policy "clip_reviews_update_own"
  on public.clip_reviews for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "clip_reviews_delete_own"
  on public.clip_reviews for delete
  using (auth.uid() = user_id);
