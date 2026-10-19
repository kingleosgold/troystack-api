-- Reports people file on Troy's replies, for a person to review. Google
-- Play's AI-generated content policy wants a way to report a reply from
-- inside the app, and POST /v1/troy/report keeps each one here.
-- Paste into the Supabase SQL Editor for the troystack project. Re-run safe.
--
-- Row-level security is on with no policies, so the public key the apps ship
-- with can't read or write a row. Only the API's service role reaches it.
-- The ids aren't foreign keys, so a report outlives the chat or account it
-- came from, and a visitor who isn't signed in can file one with no user id.

create table if not exists public.troy_reports (
  id uuid primary key default gen_random_uuid(),
  user_id uuid,
  conversation_id uuid,
  message_id uuid,
  reason text not null,
  content text not null check (char_length(content) <= 4000),
  reviewed_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists troy_reports_created_at_idx on public.troy_reports (created_at desc);

alter table public.troy_reports enable row level security;
revoke all on table public.troy_reports from anon, authenticated;

-- To check it after running, in the same editor:
--   select relrowsecurity from pg_class where relname = 'troy_reports';  -- true
--   select count(*) from pg_policies where tablename = 'troy_reports';    -- 0
