-- A fixed search_path on the three functions the security advisor flagged as
-- role mutable. Ran on the troystack project 10/15 through the TroyStack
-- connector. Re-run safe.
--
-- The voice cap functions name app_state without a schema, so they keep
-- public. profiles_keep_plan names only auth.role() and built-ins, so it
-- gets an empty path. Behavior is unchanged: the voice cap still counts to its
-- limit and refuses past it, and the guard still keeps a signed-in session off
-- the plan columns while service_role writes them.
--
-- handle_new_user and rls_auto_enable stay as they are. The advisor says anon
-- can call them through /rest/v1/rpc, but Postgres refuses a trigger or event
-- trigger function called directly, so there's nothing to reach. Revoking
-- EXECUTE would touch the sign-up trigger for no gain.
--
-- Rollback is in TROYSTACK_FILES as 009_rollback_function_search_path_2026-10-15.sql:
--   alter function ... reset search_path; for each of the three.

alter function public.increment_voice_cap_if_under(text, integer) set search_path = public;
alter function public.decrement_voice_cap(text) set search_path = public;
alter function public.profiles_keep_plan() set search_path = '';
