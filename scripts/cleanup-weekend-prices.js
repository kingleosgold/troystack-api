/**
 * One-time cleanup: delete price_log rows logged during market-closed hours.
 * Markets closed: Friday 5PM ET → Sunday 6PM ET.
 *
 * Usage: node scripts/cleanup-weekend-prices.js [--dry-run]
 */
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const etFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  weekday: 'short',
  hour: 'numeric',
  hourCycle: 'h23',
});

function isDuringMarketClose(isoTimestamp) {
  const date = new Date(isoTimestamp);
  const parts = {};
  for (const p of etFmt.formatToParts(date)) parts[p.type] = p.value;

  const dayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const day = dayMap[parts.weekday];
  const hour = parseInt(parts.hour, 10);

  return (
    day === 6 ||                    // Saturday all day
    (day === 0 && hour < 18) ||     // Sunday before 6PM ET
    (day === 5 && hour >= 17)       // Friday at/after 5PM ET
  );
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');

  console.log(`Weekend price_log cleanup ${dryRun ? '(DRY RUN)' : '(LIVE DELETE)'}`);
  console.log('Fetching all price_log rows...\n');

  // Fetch all rows (paginated — Supabase default limit is 1000)
  let allRows = [];
  let offset = 0;
  const pageSize = 1000;

  while (true) {
    const { data, error } = await supabase
      .from('price_log')
      .select('id, timestamp')
      .order('timestamp', { ascending: true })
      .range(offset, offset + pageSize - 1);

    if (error) {
      console.error('Fetch error:', error.message);
      process.exit(1);
    }

    if (!data || data.length === 0) break;
    allRows = allRows.concat(data);
    offset += pageSize;
    if (data.length < pageSize) break;
  }

  console.log(`Total rows in price_log: ${allRows.length}`);

  // Find weekend rows
  const weekendRows = allRows.filter(row => isDuringMarketClose(row.timestamp));

  console.log(`Weekend/closed-market rows: ${weekendRows.length}`);
  console.log(`Rows to keep: ${allRows.length - weekendRows.length}\n`);

  if (weekendRows.length === 0) {
    console.log('Nothing to clean up.');
    return;
  }

  // Show sample of what will be deleted
  const sample = weekendRows.slice(0, 5);
  console.log('Sample rows to delete:');
  for (const row of sample) {
    const d = new Date(row.timestamp);
    const etStr = d.toLocaleString('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: 'numeric', minute: '2-digit', hour12: true });
    console.log(`  id=${row.id}  ${row.timestamp}  (${etStr} ET)`);
  }
  if (weekendRows.length > 5) console.log(`  ... and ${weekendRows.length - 5} more`);
  console.log('');

  if (dryRun) {
    console.log('Dry run complete. Run without --dry-run to delete.');
    return;
  }

  // Delete in batches of 100 (Supabase .in() has limits)
  const ids = weekendRows.map(r => r.id);
  const batchSize = 100;
  let deleted = 0;

  for (let i = 0; i < ids.length; i += batchSize) {
    const batch = ids.slice(i, i + batchSize);
    const { error } = await supabase
      .from('price_log')
      .delete()
      .in('id', batch);

    if (error) {
      console.error(`Delete error at batch ${i}: ${error.message}`);
    } else {
      deleted += batch.length;
      process.stdout.write(`\rDeleted ${deleted}/${ids.length}`);
    }
  }

  console.log(`\n\nDone. Deleted ${deleted} weekend rows from price_log.`);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
