-- Every Signal page loads its hero image from the stack-signal-images pool,
-- 510 DALL-E PNGs of about 3 MB each. src/services/signal-image-web.js makes
-- a 1200px JPEG of each at web/<name>.jpg and points each article at its copy.
-- It only moves rows once this table exists, so the old image_url of every
-- article is saved first. Runs on the troystack project through the TroyStack
-- connector before the merge. Re-run safe, it never overwrites a saved URL.
--
-- The table has row-level security on, no policies and no grants to the
-- public roles, like news_title_backup.
--
-- Rollback (the PNGs are never removed):
--   update public.stack_signal_articles a set image_url = b.image_url
--   from public.signal_image_url_backup b where a.id = b.id;
-- Articles saved after this ran have no backup row. Their URL goes back with:
--   update public.stack_signal_articles
--   set image_url = regexp_replace(image_url, '/stack-signal-images/web/(.*)\.jpg$', '/stack-signal-images/\1.png')
--   where image_url like '%/stack-signal-images/web/%.jpg';

begin;

create table if not exists public.signal_image_url_backup (
  id uuid primary key,
  image_url text,
  saved_at timestamptz not null default now()
);

alter table public.signal_image_url_backup enable row level security;
revoke all on table public.signal_image_url_backup from anon, authenticated;

insert into public.signal_image_url_backup (id, image_url)
select id, image_url
from public.stack_signal_articles
where image_url is not null
on conflict (id) do nothing;

commit;
