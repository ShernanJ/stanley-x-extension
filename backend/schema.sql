-- Minimal schema for persisting X-draft generations in a relational DB.
-- This is optional for the local in-memory server, but useful once you move
-- backend state to Postgres/Supabase/etc.

create table if not exists x_draft_generations (
  id bigserial primary key,
  thread_id text not null,
  source_hash text not null,
  source_text text not null,
  x_text text not null,
  model text not null,
  generation_reason text,
  created_at timestamptz not null default now()
);

create unique index if not exists idx_x_draft_generations_thread_hash
  on x_draft_generations (thread_id, source_hash);

create index if not exists idx_x_draft_generations_thread_created_at
  on x_draft_generations (thread_id, created_at desc);
