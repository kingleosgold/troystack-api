// Runs the 11:30 UTC intelligence generation once after a restart that
// missed it.
//
// The cron lives in the process. A deploy that lands around 11:30 UTC can
// stop the old instance mid-run, and the new instance starts after the
// minute has passed, so nothing runs that day and intelligence_briefs stays
// empty until tomorrow. That happened on 11/3. So when the server starts
// after 11:30 UTC and today has no briefs, it runs the generation once.
//
// An app_state row claims the day first, so a crash loop or a second
// replica can't run it again. A server that starts before 11:30 leaves it to
// its own cron.

// The cron fires at 11:30:00 UTC. node-cron checks each second, so a server
// that starts any later in that minute has already missed it.
const CRON_SECOND_UTC = (11 * 60 + 30) * 60;
const START_DELAY_MS = 60 * 1000;

function utcDay(now) {
  return new Date(now).toISOString().split('T')[0];
}

function afterCron(now) {
  const d = new Date(now);
  return d.getUTCHours() * 3600 + d.getUTCMinutes() * 60 + d.getUTCSeconds() > CRON_SECOND_UTC;
}

// deps: { supabase, run, log }. run is runIntelligenceGeneration.
async function catchUpIntelligence({ supabase, run, log = console.log, bootTime = Date.now(), now = Date.now() }) {
  if (!afterCron(bootTime)) return { ran: false, reason: 'started before the cron' };
  const today = utcDay(now);
  // A server started late on day one and checked after midnight UTC would
  // look at a day whose cron hasn't fired yet.
  if (today !== utcDay(bootTime)) return { ran: false, reason: 'day changed' };

  const { count, error } = await supabase
    .from('intelligence_briefs')
    .select('id', { count: 'exact', head: true })
    .eq('date', today);
  if (error) return { ran: false, reason: `count failed: ${error.message}` };
  if (count > 0) return { ran: false, reason: `${count} briefs already` };

  const { error: lockError } = await supabase
    .from('app_state')
    .insert({ key: `intelligence_catchup_${today}`, value: JSON.stringify({ claimed_at: new Date(now).toISOString() }) });
  if (lockError) return { ran: false, reason: 'already claimed today' };

  log(`🧠 [Intelligence Catch-up] No briefs for ${today} after the 11:30 UTC cron, running it now`);
  const result = await run();
  log(`🧠 [Intelligence Catch-up] Done: ${result.briefsInserted} briefs, ${result.vaultInserted}/4 vault`);
  return { ran: true, result };
}

function scheduleIntelligenceCatchUp({ delayMs = START_DELAY_MS } = {}) {
  const bootTime = Date.now();
  const timer = setTimeout(() => {
    const supabase = require('../lib/supabase');
    const { runIntelligenceGeneration } = require('../routes/intelligence');
    catchUpIntelligence({ supabase, run: runIntelligenceGeneration, bootTime })
      .then(r => { if (!r.ran) console.log(`🧠 [Intelligence Catch-up] Skipped: ${r.reason}`); })
      .catch(err => console.error(`🧠 [Intelligence Catch-up] Failed: ${err.message}`));
  }, delayMs);
  if (timer.unref) timer.unref();
  return timer;
}

module.exports = { catchUpIntelligence, scheduleIntelligenceCatchUp, afterCron, utcDay };
