-- Atomic increment-if-under-limit for the voice TTS daily cap.
-- Run this in Supabase SQL editor before deploying the matching JS change.
--
-- Replaces the read-check-write race pattern in /v1/troy/speak. Returns the
-- new usage count if the increment succeeded, NULL if the cap was already at
-- (or above) the limit. The PRIMARY KEY on app_state.key plus
-- SELECT ... FOR UPDATE serializes concurrent calls so they cannot all pass
-- a stale read of the counter.
--
-- Note on the value column: app_state.value is stored as text in this repo
-- (existing JS reads via parseInt, writes via String(...)). The function
-- casts text -> int -> text and tolerates NULL / empty-string defensively
-- in case any prior writer left a malformed row.

create or replace function increment_voice_cap_if_under(
  p_key text,
  p_limit integer
) returns integer
language plpgsql
as $$
declare
  v_old integer;
  v_new integer;
begin
  -- Ensure a row exists so SELECT ... FOR UPDATE has something to lock.
  -- If the row already exists, this is a no-op (DO NOTHING).
  insert into app_state (key, value)
    values (p_key, '0')
    on conflict (key) do nothing;

  -- Acquire row-level lock and read the current value. Concurrent callers
  -- queue here until each predecessor's transaction commits.
  select coalesce(nullif(value, '')::integer, 0)
    into v_old
    from app_state
    where key = p_key
    for update;

  if v_old + 1 > p_limit then
    return null; -- cap hit; do not increment
  end if;

  v_new := v_old + 1;

  update app_state
    set value = v_new::text
    where key = p_key;

  return v_new;
end;
$$;
