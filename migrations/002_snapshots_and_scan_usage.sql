-- Portfolio snapshots table (daily portfolio value tracking)
CREATE TABLE IF NOT EXISTS portfolio_snapshots (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id TEXT NOT NULL,
  date DATE NOT NULL,
  total_value DOUBLE PRECISION DEFAULT 0,
  gold_value DOUBLE PRECISION DEFAULT 0,
  silver_value DOUBLE PRECISION DEFAULT 0,
  platinum_value DOUBLE PRECISION DEFAULT 0,
  palladium_value DOUBLE PRECISION DEFAULT 0,
  gold_oz DOUBLE PRECISION DEFAULT 0,
  silver_oz DOUBLE PRECISION DEFAULT 0,
  platinum_oz DOUBLE PRECISION DEFAULT 0,
  palladium_oz DOUBLE PRECISION DEFAULT 0,
  gold_spot DOUBLE PRECISION DEFAULT 0,
  silver_spot DOUBLE PRECISION DEFAULT 0,
  platinum_spot DOUBLE PRECISION DEFAULT 0,
  palladium_spot DOUBLE PRECISION DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, date)
);

CREATE INDEX IF NOT EXISTS idx_snapshots_user_date ON portfolio_snapshots(user_id, date);

-- Scan usage tracking table
CREATE TABLE IF NOT EXISTS scan_usage (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id TEXT NOT NULL UNIQUE,
  scans_used INTEGER DEFAULT 0,
  period_start TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_scan_usage_user ON scan_usage(user_id);
