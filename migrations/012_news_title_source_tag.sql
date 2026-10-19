-- About a third of the Signal's news items carried Google News' publisher tag
-- in their title, like "Gold steady as yields rise - Reuters", because the
-- headline was copied whole from the source. This drops the tag, by the same
-- rule as stripSourceTag in src/services/headline.js: only on a news item, not
-- a recap, and only when a Google News source shows the title is its headline,
-- by the source's title, its description (headline and publisher two spaces
-- apart) or its name. Slugs and sources stay as they are. New items get the
-- same title from stack-signal-processor.js. Runs on the troystack project
-- through the TroyStack connector after the merge. Re-run safe.
--
-- The old titles go to news_title_backup first. It has row-level security on,
-- no policies and no grants to the public roles, like recap_title_backup.
--
-- Rollback:
--   update public.stack_signal_articles a set title = b.title
--   from public.news_title_backup b where a.id = b.id;
--   drop table public.news_title_backup;

begin;

create table if not exists public.news_title_backup (
  id uuid primary key,
  slug text not null,
  title text,
  saved_at timestamptz not null default now()
);

alter table public.news_title_backup enable row level security;
revoke all on table public.news_title_backup from anon, authenticated;

create temporary table news_title_fix on commit drop as
select a.id, a.slug, a.title, t.head
from public.stack_signal_articles a
cross join lateral (
  select (regexp_match(a.title, '^(.*) - ([^ ].*)$'))[1] as head,
         (regexp_match(a.title, '^(.*) - ([^ ].*)$'))[2] as tail
) t
where a.is_stack_signal is not true
  and t.head is not null
  and btrim(t.head) <> ''
  and jsonb_typeof(a.sources) = 'array'
  and exists (
    select 1
    from jsonb_array_elements(a.sources) s
    where s->>'url' like 'https://news.google.com/%'
      and (
        s->>'title' = a.title
        or s->>'description' = t.head || '  ' || t.tail
        or lower(s->>'name') = lower(t.tail)
      )
  );

insert into public.news_title_backup (id, slug, title)
select id, slug, title from news_title_fix
on conflict (id) do nothing;

update public.stack_signal_articles a
set title = f.head
from news_title_fix f
where a.id = f.id;

commit;
