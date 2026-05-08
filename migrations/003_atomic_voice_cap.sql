-- Atomic increment-if-under-limit for the voice TTS daily cap.
-- Run this in Supabase SQL editor before deploying the matching JS change.
--
-- Replaces the read-check-write race pattern in /v1/troy/speak. Returns the
-- new usage count if the increment succeeded, NULL if the cap was already at
-- (or above) the limit. The PRIMARY KEY on app_state.key plus
-- SELECT ... FOR UPDATE serializes concurrent calls so they cannot all pass
-- a stale read of the counter.
--
-- Note on the value column: app_state.value is a jsonb column storing
-- JSON-string scalars (e.g. "21", not the integer 21). The existing JS
-- reads via JSON.parse and writes via JSON.stringify, so this function
-- preserves that format using `value #>> '{}'` to extract the scalar as
-- text and `to_jsonb(text)` to write it back. Tolerates NULL / empty-string
-- defensively in case any prior writer left a malformed row.

create or replace function increment_voice_cap_if_under(
  p_key text,
  p_limit integer
) returns integer
language plpgsql
as $$
declare
  v_old integer;
  v_new integer;
  v_text text;
begin
  -- Ensure a row exists so SELECT ... FOR UPDATE has something to lock.
  -- If the row already exists, this is a no-op (DO NOTHING).
  insert into app_state (key, value)
    values (p_key, to_jsonb('0'::text))
    on conflict (key) do nothing;

  -- Acquire row-level lock and read the current value. Concurrent callers
  -- queue here until each predecessor's transaction commits. The
  -- `value #>> '{}'` operator extracts a jsonb scalar as text (without
  -- the JSON quotation marks).
  select coalesce(nullif(value #>> '{}', '')::integer, 0)
    into v_old
    from app_state
    where key = p_key
    for update;

  if v_old + 1 > p_limit then
    return null; -- cap hit; do not increment
  end if;

  v_new := v_old + 1;
  v_text := v_new::text;

  update app_state
    set value = to_jsonb(v_text), updated_at = now()
    where key = p_key;

  return v_new;
end;
$$;

-- Best-effort decrement for cap rollback when a voice request fails before
-- delivering audio. Mirrors the jsonb-string format of
-- increment_voice_cap_if_under. Returns the new value on success, NULL if the
-- row doesn't exist or value is already 0 (cannot decrement below zero).
-- Fire-and-forget from the caller — if this fails, over-counting the cap is
-- the safer side vs. risking under-count via double-decrement on retries.

create or replace function decrement_voice_cap(
  p_key text
) returns integer
language plpgsql
as $$
declare
  v_old integer;
  v_new integer;
begin
  -- Acquire row lock and read current value.
  select coalesce(nullif(value #>> '{}', '')::integer, 0)
    into v_old
    from app_state
    where key = p_key
    for update;

  -- No row, or already at zero — nothing to decrement.
  if v_old is null or v_old <= 0 then
    return null;
  end if;

  v_new := v_old - 1;

  update app_state
    set value = to_jsonb(v_new::text), updated_at = now()
    where key = p_key;

  return v_new;
end;
$$;
