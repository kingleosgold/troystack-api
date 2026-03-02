/**
 * Migration: Create social feature tables (views, likes, comments)
 * and add count columns to stack_signal_articles.
 *
 * Run once: node scripts/setup-social-tables.js
 */
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

async function run() {
  console.log('Setting up social tables...\n');

  // 1. article_views
  const { error: e1 } = await supabase.rpc('exec_sql', {
    sql: `
      CREATE TABLE IF NOT EXISTS article_views (
        id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
        article_id UUID NOT NULL REFERENCES stack_signal_articles(id) ON DELETE CASCADE,
        user_id TEXT,
        device_id TEXT,
        created_at TIMESTAMPTZ DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS idx_article_views_article ON article_views(article_id);
      CREATE INDEX IF NOT EXISTS idx_article_views_user ON article_views(user_id);
    `
  });
  if (e1) console.error('article_views error:', e1.message);
  else console.log('✅ article_views table ready');

  // 2. article_likes
  const { error: e2 } = await supabase.rpc('exec_sql', {
    sql: `
      CREATE TABLE IF NOT EXISTS article_likes (
        id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
        article_id UUID NOT NULL REFERENCES stack_signal_articles(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL,
        created_at TIMESTAMPTZ DEFAULT now(),
        UNIQUE(article_id, user_id)
      );
      CREATE INDEX IF NOT EXISTS idx_article_likes_article ON article_likes(article_id);
      CREATE INDEX IF NOT EXISTS idx_article_likes_user ON article_likes(user_id);
    `
  });
  if (e2) console.error('article_likes error:', e2.message);
  else console.log('✅ article_likes table ready');

  // 3. article_comments
  const { error: e3 } = await supabase.rpc('exec_sql', {
    sql: `
      CREATE TABLE IF NOT EXISTS article_comments (
        id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
        article_id UUID NOT NULL REFERENCES stack_signal_articles(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TIMESTAMPTZ DEFAULT now(),
        updated_at TIMESTAMPTZ DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS idx_article_comments_article ON article_comments(article_id);
    `
  });
  if (e3) console.error('article_comments error:', e3.message);
  else console.log('✅ article_comments table ready');

  // 4. Add count columns to stack_signal_articles
  const { error: e4 } = await supabase.rpc('exec_sql', {
    sql: `
      ALTER TABLE stack_signal_articles
        ADD COLUMN IF NOT EXISTS view_count INTEGER DEFAULT 0,
        ADD COLUMN IF NOT EXISTS like_count INTEGER DEFAULT 0,
        ADD COLUMN IF NOT EXISTS comment_count INTEGER DEFAULT 0;
    `
  });
  if (e4) console.error('alter table error:', e4.message);
  else console.log('✅ count columns added to stack_signal_articles');

  console.log('\nDone! If any errors above, run the SQL directly in Supabase dashboard.');
}

run().catch(console.error);
