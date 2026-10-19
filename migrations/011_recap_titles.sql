-- Every recap on troystack.com/signal and in the app was titled The Stack
-- Signal, so the morning, evening and weekly pages for one day carried the
-- same title, and all but two carried an em dash the house style bans. This
-- retitles each recap by its edition, read from its slug, and keeps the date
-- it already shows: Evening Signal: October 16, 2026. New recaps get the same
-- shape from stack-signal-processor.js. Runs on the troystack project through
-- the TroyStack connector after the merge. Re-run safe.
--
-- The old titles go to recap_title_backup first. It has row-level security on,
-- no policies and no grants to the public roles, like funnel_counts.
--
-- Rollback:
--   update public.stack_signal_articles a set title = b.title
--   from public.recap_title_backup b where a.id = b.id;
--   drop table public.recap_title_backup;

begin;

create table if not exists public.recap_title_backup (
  id uuid primary key,
  slug text not null,
  title text,
  saved_at timestamptz not null default now()
);

alter table public.recap_title_backup enable row level security;
revoke all on table public.recap_title_backup from anon, authenticated;

insert into public.recap_title_backup (id, slug, title)
select id, slug, title
from public.stack_signal_articles
where is_stack_signal is true
on conflict (id) do nothing;

update public.stack_signal_articles a
set title = e.label || ': ' || (regexp_match(a.title, '(?:January|February|March|April|May|June|July|August|September|October|November|December) \d{1,2}, \d{4}'))[1]
from (values
  ('the-stack-signal-', 'The Stack Signal'),
  ('evening-signal-', 'Evening Signal'),
  ('weekly-recap-', 'Weekly Recap'),
  ('week-ahead-', 'The Week Ahead'),
  ('monthly-review-', 'Monthly Review'),
  ('year-in-review-', 'Year in Review')
) as e(prefix, label)
where a.is_stack_signal is true
  and starts_with(a.slug, e.prefix)
  and a.title ~ '(?:January|February|March|April|May|June|July|August|September|October|November|December) \d{1,2}, \d{4}';

commit;

-- Check: select has_table_privilege('anon', 'public.recap_title_backup', 'select');
-- returns false, and
--   select count(*) from public.stack_signal_articles
--   where is_stack_signal is true and strpos(title, chr(8212)) > 0;
-- returns 0.
