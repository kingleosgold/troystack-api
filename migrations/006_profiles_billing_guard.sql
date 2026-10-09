-- Plan columns on profiles change only from the server.
-- Paste into the Supabase SQL Editor for the troystack project. Re-run safe.
--
-- The one row-level policy on profiles, "Users can view own profile", is FOR
-- ALL USING (auth.uid() = id). A signed-in user can therefore update their
-- own row with the app's public key and their own session, plan columns
-- included, and set subscription_tier to 'lifetime' without paying.
--
-- This trigger keeps the plan columns as they were on any insert or update
-- made with a user's session (the anon and authenticated roles), and gives a
-- row a user inserts the free plan. The API's service role, the Stripe and
-- RevenueCat webhooks it runs, and the SQL editor are unaffected, so plans
-- still reach profiles through checkout, verify-session, the webhooks and the
-- sign-in repair. The iPhone app's own profile sync then changes nothing in
-- these columns, which also stops it writing free over a plan bought on the
-- web. App Store plans reach profiles through the RevenueCat webhook, the
-- "Supabase Sync" connection pointed at /v1/webhooks/revenuecat.
--
-- Run this only after the webhook in src/routes/revenuecat-webhook.js is
-- deployed. It applies the one-time lifetime purchase and answers 500 on a
-- failed write so RevenueCat retries. The old handler did neither, and with
-- the app's own writes blocked a new App Store lifetime buyer would stay free.

create or replace function public.profiles_keep_plan()
returns trigger
language plpgsql
as $$
begin
  if coalesce(auth.role(), '') in ('anon', 'authenticated') then
    if tg_op = 'INSERT' then
      new.subscription_tier := 'free';
      new.subscription_status := null;
      new.subscription_expires_at := null;
      new.trial_end := null;
      new.stripe_customer_id := null;
    else
      new.subscription_tier := old.subscription_tier;
      new.subscription_status := old.subscription_status;
      new.subscription_expires_at := old.subscription_expires_at;
      new.trial_end := old.trial_end;
      new.stripe_customer_id := old.stripe_customer_id;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists profiles_keep_plan on public.profiles;
create trigger profiles_keep_plan
  before insert or update on public.profiles
  for each row execute function public.profiles_keep_plan();

-- To check it after running, in the same editor. Everything inside the
-- transaction is rolled back, so no row changes. Put a real profile id in
-- both places.
--
-- begin;
--   set local role authenticated;
--   select set_config('request.jwt.claims', '{"role":"authenticated","sub":"PROFILE-ID"}', true);
--   update public.profiles set subscription_tier = 'lifetime' where id = 'PROFILE-ID';
--   select subscription_tier from public.profiles where id = 'PROFILE-ID';  -- still the old plan
-- rollback;
