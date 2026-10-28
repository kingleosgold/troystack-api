-- Podcast episode titles carried only the date, The Stack Signal: October 28,
-- 2026, and the older ones an em dash the house style bans. Nobody searches
-- for a date, and every podcast app already shows the show's name. From this
-- change services/podcast-title.js titles each new episode with the day's
-- news and a short date, like Gold Holds $4,057, Silver $53.77 as Fed
-- Decision Looms | Oct 28. This retitles the last 14 episodes the same way,
-- each title checked against that episode's own notes, and takes the em dash
-- out of every older dated title. Only podcast_episodes.title changes. The
-- guid is the slug, so podcast apps update the title and download nothing
-- again. The Signal articles keep their own titles.
--
-- Runs on the troystack project through the TroyStack connector, on its own
-- or after the merge. It needs no deploy, and the feed shows the new titles
-- within its 10-minute cache. Re-run safe.
--
-- No backup table, since every old title is the episode's date and the
-- rollback rebuilds it from the slug. The rollback gives the colon form, the
-- way 011 left the Signal articles, never the em dash:
--   update public.podcast_episodes
--   set title = 'The Stack Signal: ' || to_char(substring(slug from '(\d{4}-\d{2}-\d{2})$')::date, 'FMMonth FMDD, YYYY')
--   where slug ~ '^the-stack-signal-\d{4}-\d{2}-\d{2}$';

begin;

update public.podcast_episodes e
set title = v.title
from (values
  ('the-stack-signal-2026-10-28', 'Gold Holds $4,057, Silver $53.77 as Fed Decision Looms | Oct 28'),
  ('the-stack-signal-2026-10-27', 'Gold Holds Above $4,000 Into the Fed as Dollar Firms | Oct 27'),
  ('the-stack-signal-2026-10-26', 'Silver $53.98 as London Vaults Run Thin on Supply | Oct 26'),
  ('the-stack-signal-2026-10-25', 'Gold Slips to $4,007 as Oil Stokes Rate-Hike Fears | Oct 25'),
  ('the-stack-signal-2026-10-24', 'Silver Drops Under $55 as Gold/Silver Ratio Widens to 74.3 | Oct 24'),
  ('the-stack-signal-2026-10-23', 'Gold Tests $4,000 as Oil Shock Lifts Fed Hike Bets | Oct 23'),
  ('the-stack-signal-2026-10-22', 'Gold Slips Under $4,100; Royal Mint Silver Demand Holds | Oct 22'),
  ('the-stack-signal-2026-10-21', 'Gold Slides to $4,147 on December Rate-Hike Fears | Oct 21'),
  ('the-stack-signal-2026-10-20', 'Gold $4,139, Silver $57.27 Trade the Fed''s Next Move | Oct 20'),
  ('the-stack-signal-2026-10-19', 'Central Banks Keep Buying as Gold Holds $4,192 | Oct 19'),
  ('the-stack-signal-2026-10-18', 'Hot Inflation Knocks Gold to $4,181 on Rate Fears | Oct 18'),
  ('the-stack-signal-2026-10-17', 'Inflation Hits 3-Year High as Gold Holds $4,187 | Oct 17'),
  ('the-stack-signal-2026-10-16', 'Gold Holds $4,197 as Yields Fall and Dollar Softens | Oct 16'),
  ('the-stack-signal-2026-10-15', 'Gold Whipsaws on 3.7% Inflation Print, Rebounds to $4,180 | Oct 15')
) as v(slug, title)
where e.slug = v.slug;

-- Every older dated title keeps its date and loses the em dash:
-- The Stack Signal: October 13, 2026.
update public.podcast_episodes
set title = regexp_replace(title, '\s*' || chr(8212) || '\s*', ': ', 'g')
where strpos(title, chr(8212)) > 0;

commit;

-- Check: both return 0.
--   select count(*) from public.podcast_episodes where strpos(title, chr(8212)) > 0;
--   select count(*) from public.podcast_episodes where length(title) > 70;
