-- app_state is for the API alone. Paste into the Supabase SQL Editor for the
-- troystack project, and run it before pull requests #19 and #21 go live.
-- Re-run safe.
--
-- app_state has row-level security on, with one policy, "Public read app
-- state", that lets SELECT through for everyone. Anyone holding the public
-- key the iPhone app and the web app ship with can read every row, signed in
-- or not. Today that's the usage counters, keyed by user id. #19 and #21 add
-- each account's App Store purchase record, revenuecat_grant:{userId}, with
-- its purchase times, refunds, Lifetime and whether the account has had an
-- App Store plan, and the rows that make an account's checkouts and
-- RevenueCat events take turns, checkout_turn:{userId} and
-- revenuecat_turn:{userId}. None of that should be readable with the public
-- key, so this runs first.
--
-- Nothing outside the API reads app_state, and the API uses the service
-- role, which row-level security doesn't apply to and which keeps its own
-- grants. This drops the read policy, so the public roles see no rows, and
-- takes the table's privileges off anon and authenticated too.
--
-- The two voice cap functions from migration 003 run as their caller, so a
-- public caller can't reach app_state through them today either. Execute on
-- them goes from public, anon and authenticated to service_role alone, so
-- that if one is ever changed to run as its owner it still can't be called
-- with the public key.

-- Already on in the live database. It's set here too, so a database built
-- from these files ends up the same.
alter table public.app_state enable row level security;

drop policy if exists "Public read app state" on public.app_state;

revoke all on table public.app_state from anon, authenticated;

revoke execute on function public.increment_voice_cap_if_under(text, integer) from public, anon, authenticated;
revoke execute on function public.decrement_voice_cap(text) from public, anon, authenticated;
grant execute on function public.increment_voice_cap_if_under(text, integer) to service_role;
grant execute on function public.decrement_voice_cap(text) to service_role;

-- To check it after running, in the same editor:
--
-- select policyname from pg_policies where schemaname = 'public' and tablename = 'app_state';  -- no rows
-- select has_table_privilege('anon', 'public.app_state', 'select');  -- false
-- select has_table_privilege('authenticated', 'public.app_state', 'select');  -- false
-- select has_function_privilege('anon', 'public.increment_voice_cap_if_under(text, integer)', 'execute');  -- false
-- select has_function_privilege('authenticated', 'public.decrement_voice_cap(text)', 'execute');  -- false
-- select has_function_privilege('service_role', 'public.increment_voice_cap_if_under(text, integer)', 'execute');  -- true
