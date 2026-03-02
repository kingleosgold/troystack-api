/**
 * Migration: Add granular notification preference columns
 *
 * Adds morning_brief, market_alerts, critical_alerts columns to
 * notification_preferences table. Keeps existing daily_brief column
 * for backward compatibility.
 *
 * Run: node scripts/add-notification-pref-columns.js
 *
 * Alternatively, run this SQL directly in Supabase SQL Editor:
 *
 *   ALTER TABLE notification_preferences
 *     ADD COLUMN IF NOT EXISTS morning_brief BOOLEAN DEFAULT true,
 *     ADD COLUMN IF NOT EXISTS market_alerts BOOLEAN DEFAULT true,
 *     ADD COLUMN IF NOT EXISTS critical_alerts BOOLEAN DEFAULT true;
 */

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

async function run() {
  console.log('Adding notification preference columns...');

  const { error } = await supabase.rpc('exec_sql', {
    query: `
      ALTER TABLE notification_preferences
        ADD COLUMN IF NOT EXISTS morning_brief BOOLEAN DEFAULT true,
        ADD COLUMN IF NOT EXISTS market_alerts BOOLEAN DEFAULT true,
        ADD COLUMN IF NOT EXISTS critical_alerts BOOLEAN DEFAULT true;
    `
  });

  if (error) {
    // rpc('exec_sql') may not exist — print the SQL to run manually
    console.log('\nAutomatic migration failed:', error.message);
    console.log('\nRun this SQL manually in Supabase SQL Editor:\n');
    console.log(`  ALTER TABLE notification_preferences`);
    console.log(`    ADD COLUMN IF NOT EXISTS morning_brief BOOLEAN DEFAULT true,`);
    console.log(`    ADD COLUMN IF NOT EXISTS market_alerts BOOLEAN DEFAULT true,`);
    console.log(`    ADD COLUMN IF NOT EXISTS critical_alerts BOOLEAN DEFAULT true;`);
    return;
  }

  console.log('Done — columns added successfully.');
}

run().catch(err => {
  console.error('Migration error:', err.message);
  process.exit(1);
});
