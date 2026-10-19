-- Daily counts of each step from the Gold page to an open checkout, so the
-- next fix on troystack.ai is picked by numbers. POST /v1/funnel counts the
-- page view, the plan tap and the sign-up, and the API counts a checkout it
-- opened. Ran on the troystack project through the TroyStack connector.
-- Re-run safe.
--
-- A row is a day, a step, a plan and the surface that sent it. No user id,
-- IP or browser id is kept, so a count can't be traced back to anyone.
-- Row-level security is on with no policies and the public roles have no
-- grants, so only the API's service role reads or writes it.
--
-- To read the last week:
--   select step, plan, campaign, sum(count) from public.funnel_counts
--   where day > current_date - 7 group by 1, 2, 3 order by 1, 4 desc;
--
-- Rollback: drop function public.bump_funnel_count(date, text, text, text);
--           drop table public.funnel_counts;

create table if not exists public.funnel_counts (
  day date not null,
  step text not null check (step in ('gold_view', 'plan_tap', 'signup', 'checkout_open')),
  plan text not null default '' check (plan in ('', 'monthly', 'yearly', 'lifetime')),
  campaign text not null default '' check (campaign ~ '^[a-z0-9-]{0,40}$'),
  count integer not null default 0,
  primary key (day, step, plan, campaign)
);

alter table public.funnel_counts enable row level security;
revoke all on table public.funnel_counts from anon, authenticated;

create or replace function public.bump_funnel_count(p_day date, p_step text, p_plan text, p_campaign text)
returns void
language sql
set search_path = public
as $$
  insert into public.funnel_counts (day, step, plan, campaign, count)
  values (p_day, p_step, p_plan, p_campaign, 1)
  on conflict (day, step, plan, campaign) do update set count = public.funnel_counts.count + 1;
$$;

revoke execute on function public.bump_funnel_count(date, text, text, text) from public, anon, authenticated;
grant execute on function public.bump_funnel_count(date, text, text, text) to service_role;

-- To check it after running, in the same editor:
--   select relrowsecurity from pg_class where relname = 'funnel_counts';  -- true
--   select has_table_privilege('anon', 'public.funnel_counts', 'select');  -- false
--   select has_function_privilege('anon', 'public.bump_funnel_count(date, text, text, text)', 'execute');  -- false
