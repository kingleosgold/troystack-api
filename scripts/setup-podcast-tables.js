/**
 * Setup script: creates the podcast_episodes table (podcast v1).
 *
 * Follows the repo convention (see setup-troy-chat-tables.js): connects via
 * DATABASE_URL to run DDL directly; if DATABASE_URL is not set, prints the
 * SQL for manual execution in the Supabase SQL Editor.
 *
 * Usage: node scripts/setup-podcast-tables.js
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');

const SQL = fs.readFileSync(path.join(__dirname, '..', 'migrations', '004_podcast_episodes.sql'), 'utf-8');

async function setup() {
  console.log('Podcast table setup\n');

  const dbUrl = process.env.DATABASE_URL;
  if (dbUrl) {
    try {
      const { default: pg } = await import('pg');
      const client = new pg.Client({ connectionString: dbUrl });
      await client.connect();
      console.log('Connected to Postgres directly.\n');
      await client.query(SQL);
      await client.end();
      console.log('✅ podcast_episodes created (or already existed).');
      return;
    } catch (err) {
      console.error('❌ Direct DDL failed:', err.message);
      console.log('\nFalling back to manual SQL:\n');
    }
  }

  console.log('DATABASE_URL not set — run this SQL in the Supabase SQL Editor:\n');
  console.log(SQL);
}

setup();
