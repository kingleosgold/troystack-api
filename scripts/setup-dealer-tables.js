/**
 * Setup script: creates dealer_prices and affiliate_clicks tables.
 * Run: node scripts/setup-dealer-tables.js
 *
 * Or run the SQL directly in Supabase dashboard.
 */
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const SQL = `
CREATE TABLE IF NOT EXISTS dealer_prices (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  dealer text NOT NULL,
  product_name text NOT NULL,
  metal text NOT NULL,
  weight_oz numeric NOT NULL,
  price numeric NOT NULL,
  premium_pct numeric,
  product_url text NOT NULL,
  scraped_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_dealer_prices_metal_weight ON dealer_prices(metal, weight_oz);
CREATE INDEX IF NOT EXISTS idx_dealer_prices_scraped_at ON dealer_prices(scraped_at);

CREATE TABLE IF NOT EXISTS affiliate_clicks (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid,
  dealer text NOT NULL,
  product_name text NOT NULL,
  metal text NOT NULL,
  weight_oz numeric NOT NULL,
  clicked_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_affiliate_clicks_user ON affiliate_clicks(user_id);
CREATE INDEX IF NOT EXISTS idx_affiliate_clicks_dealer ON affiliate_clicks(dealer, clicked_at);
`;

async function run() {
  console.log('Creating dealer_prices and affiliate_clicks tables...');

  const { error } = await supabase.rpc('exec_sql', { sql: SQL });

  if (error) {
    console.log('RPC exec_sql not available — run this SQL in Supabase dashboard:');
    console.log(SQL);
  } else {
    console.log('Tables created successfully.');
  }

  // Verify tables exist
  const { error: dpErr } = await supabase.from('dealer_prices').select('id').limit(1);
  console.log('  dealer_prices:', dpErr ? `ERROR: ${dpErr.message}` : 'OK');

  const { error: acErr } = await supabase.from('affiliate_clicks').select('id').limit(1);
  console.log('  affiliate_clicks:', acErr ? `ERROR: ${acErr.message}` : 'OK');
}

run().catch(console.error);
