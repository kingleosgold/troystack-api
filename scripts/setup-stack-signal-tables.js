/**
 * Setup script: creates stack_signal_articles table with indexes and RLS.
 *
 * Connects to Supabase via DATABASE_URL for DDL, or prints SQL for manual execution.
 *
 * Usage: node scripts/setup-stack-signal-tables.js
 */
require('dotenv').config();

const SQL = `
-- Stack Signal: articles + daily synthesis
CREATE TABLE IF NOT EXISTS stack_signal_articles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug TEXT UNIQUE NOT NULL,
  title TEXT NOT NULL,
  troy_commentary TEXT,
  troy_one_liner TEXT,
  category TEXT CHECK (category IN (
    'macro', 'gold', 'silver', 'mining', 'central_banks', 'geopolitical', 'market_data'
  )),
  sources JSONB DEFAULT '[]'::jsonb,
  image_url TEXT,
  image_prompt TEXT,
  gold_price_at_publish NUMERIC,
  silver_price_at_publish NUMERIC,
  relevance_score INTEGER DEFAULT 0,
  is_stack_signal BOOLEAN DEFAULT false,
  published_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_stack_signal_published
  ON stack_signal_articles(published_at DESC);

CREATE INDEX IF NOT EXISTS idx_stack_signal_category
  ON stack_signal_articles(category);

CREATE INDEX IF NOT EXISTS idx_stack_signal_slug
  ON stack_signal_articles(slug);

CREATE INDEX IF NOT EXISTS idx_stack_signal_daily
  ON stack_signal_articles(is_stack_signal, published_at DESC);

-- Row Level Security
ALTER TABLE stack_signal_articles ENABLE ROW LEVEL SECURITY;

CREATE POLICY IF NOT EXISTS "Public read access"
  ON stack_signal_articles
  FOR SELECT
  USING (true);
`;

async function setup() {
  console.log('Stack Signal table setup\n');

  const dbUrl = process.env.DATABASE_URL;
  if (dbUrl) {
    try {
      const { default: pg } = await import('pg');
      const client = new pg.Client({ connectionString: dbUrl });
      await client.connect();
      console.log('Connected to Postgres directly.\n');
      await client.query(SQL);
      console.log('All tables and indexes created successfully.\n');
      await client.end();
    } catch (err) {
      console.log(`Direct Postgres connection failed: ${err.message}`);
      console.log('Falling back to SQL output...\n');
      printSQL();
      return;
    }
  } else {
    printSQL();
    return;
  }

  await verify();
}

function printSQL() {
  console.log('No DATABASE_URL found. Run this SQL in the Supabase SQL Editor:\n');
  console.log('━'.repeat(60));
  console.log(SQL);
  console.log('━'.repeat(60));
  console.log('\nAfter running, re-run this script to verify.');
}

async function verify() {
  const { createClient } = require('@supabase/supabase-js');
  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  console.log('Verifying tables...');

  const { error: articlesErr } = await supabase.from('stack_signal_articles').select('id').limit(1);
  console.log('  stack_signal_articles:', articlesErr ? `ERROR: ${articlesErr.message}` : 'OK');

  if (articlesErr) {
    console.log('\nTable is missing. Run the SQL above in the Supabase SQL Editor.');
    process.exit(1);
  }

  console.log('\nAll tables verified. Setup complete.');
}

setup().catch(err => {
  console.error('Setup failed:', err.message);
  process.exit(1);
});
