/**
 * Setup script: creates troy_conversations, troy_messages, and troy_question_usage tables.
 *
 * This script connects to Supabase via the database connection string (DATABASE_URL)
 * to run DDL statements. If DATABASE_URL is not set, it prints the SQL for manual execution.
 *
 * Usage: node scripts/setup-troy-chat-tables.js
 */
require('dotenv').config();

const SQL = `
-- Troy Chat: conversations
CREATE TABLE IF NOT EXISTS troy_conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT 'New conversation',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_troy_conversations_user_updated
  ON troy_conversations(user_id, updated_at DESC);

-- Troy Chat: messages
CREATE TABLE IF NOT EXISTS troy_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES troy_conversations(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_troy_messages_conversation_created
  ON troy_messages(conversation_id, created_at ASC);

-- Troy Chat: daily question usage (follows scan_usage pattern)
CREATE TABLE IF NOT EXISTS troy_question_usage (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id TEXT NOT NULL UNIQUE,
  questions_used INTEGER DEFAULT 0,
  period_start TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_troy_question_usage_user
  ON troy_question_usage(user_id);
`;

async function setup() {
  console.log('Troy Chat table setup\n');

  // Try direct Postgres connection if DATABASE_URL is available
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

  // Verify via Supabase client
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

  const { error: convErr } = await supabase.from('troy_conversations').select('id').limit(1);
  console.log('  troy_conversations:', convErr ? `ERROR: ${convErr.message}` : 'OK');

  const { error: msgErr } = await supabase.from('troy_messages').select('id').limit(1);
  console.log('  troy_messages:', msgErr ? `ERROR: ${msgErr.message}` : 'OK');

  const { error: usageErr } = await supabase.from('troy_question_usage').select('id').limit(1);
  console.log('  troy_question_usage:', usageErr ? `ERROR: ${usageErr.message}` : 'OK');

  if (convErr || msgErr || usageErr) {
    console.log('\nSome tables are missing. Run the SQL above in the Supabase SQL Editor.');
    process.exit(1);
  }

  console.log('\nAll tables verified. Setup complete.');
}

setup().catch(err => {
  console.error('Setup failed:', err.message);
  process.exit(1);
});
