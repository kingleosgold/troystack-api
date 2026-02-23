/**
 * One-time fix: patch price_log rows where Pt/Pd have old hardcoded values
 * ($2700/$2000) with nearest neighbor real data.
 *
 * Usage: node scripts/patch-ptpd-outliers.js [--dry-run]
 */
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  console.log(`Pt/Pd outlier patch ${dryRun ? '(DRY RUN)' : '(LIVE PATCH)'}\n`);

  // Find all rows with old hardcoded Pt=$2700
  const { data: badRows, error } = await supabase
    .from('price_log')
    .select('id, timestamp, platinum_price, palladium_price')
    .eq('platinum_price', 2700)
    .order('timestamp', { ascending: true });

  if (error) { console.error('Fetch error:', error.message); process.exit(1); }

  console.log(`Found ${badRows.length} rows with Pt=$2700 / Pd=$2000\n`);
  if (badRows.length === 0) { console.log('Nothing to patch.'); return; }

  let patched = 0;
  let skipped = 0;

  for (const row of badRows) {
    // Find nearest GOOD row before this one
    const { data: prev } = await supabase
      .from('price_log')
      .select('platinum_price, palladium_price')
      .lt('timestamp', row.timestamp)
      .neq('platinum_price', 2700)
      .gt('platinum_price', 0)
      .order('timestamp', { ascending: false })
      .limit(1)
      .single();

    let donor = prev;

    // If no previous good row, try forward
    if (!donor) {
      const { data: next } = await supabase
        .from('price_log')
        .select('platinum_price, palladium_price')
        .gt('timestamp', row.timestamp)
        .neq('platinum_price', 2700)
        .gt('platinum_price', 0)
        .order('timestamp', { ascending: true })
        .limit(1)
        .single();
      donor = next;
    }

    if (!donor) {
      console.log(`  id=${row.id}  ${row.timestamp}  NO neighbor found, skipped`);
      skipped++;
      continue;
    }

    const etStr = new Date(row.timestamp).toLocaleString('en-US', {
      timeZone: 'America/New_York',
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hourCycle: 'h23',
    });

    if (dryRun) {
      console.log(`  id=${row.id}  ${etStr} ET  Pt $2700→$${donor.platinum_price}  Pd $2000→$${donor.palladium_price}`);
    } else {
      const { error: updateErr } = await supabase
        .from('price_log')
        .update({
          platinum_price: donor.platinum_price,
          palladium_price: donor.palladium_price,
        })
        .eq('id', row.id);

      if (updateErr) {
        console.log(`  id=${row.id}  UPDATE FAILED: ${updateErr.message}`);
        skipped++;
        continue;
      }
      console.log(`  id=${row.id}  ${etStr} ET  Pt $2700→$${donor.platinum_price}  Pd $2000→$${donor.palladium_price}`);
    }
    patched++;
  }

  console.log(`\nDone. ${dryRun ? 'Would patch' : 'Patched'} ${patched}/${badRows.length} rows (${skipped} skipped).`);

  if (!dryRun) {
    const { data: check } = await supabase.from('price_log').select('id').eq('platinum_price', 2700);
    console.log(`Remaining Pt=$2700 rows: ${check?.length || 0}`);
  }
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
