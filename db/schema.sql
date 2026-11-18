-- Thuso Student Success Multi-Tenant PostgreSQL Schema
-- Target database: student-success
-- Auto-applied on boot when DATABASE_URL is configured, or runnable in pgAdmin.

CREATE TABLE IF NOT EXISTS tenants (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  webhook_secret TEXT NOT NULL,
  integrations JSONB NOT NULL DEFAULT '{}'::jsonb,
  workspace_config JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'owner',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS learners (
  tenant_id TEXT NOT NULL DEFAULT 'default',
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  cohort TEXT NOT NULL DEFAULT 'Unassigned',
  programme TEXT NOT NULL DEFAULT 'Full-Stack Web Development',
  status TEXT NOT NULL DEFAULT 'on_track',
  quiz_avg DOUBLE PRECISION,
  risk_score DOUBLE PRECISION,
  days_since_login INTEGER DEFAULT 0,
  missed_classes INTEGER DEFAULT 0,
  missed_assignments INTEGER DEFAULT 0,
  payment_status TEXT DEFAULT 'ok',
  weak_topic TEXT,
  last_event TEXT,
  source TEXT DEFAULT 'sandbox',
  profile_data JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, id)
);

CREATE TABLE IF NOT EXISTS lms_events (
  id BIGSERIAL PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  learner_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'sandbox',
  module_code TEXT,
  score_pct DOUBLE PRECISION,
  days_since_login INTEGER,
  missed_classes INTEGER,
  missed_assignments INTEGER,
  payment_status TEXT,
  missed_questions JSONB NOT NULL DEFAULT '[]'::jsonb,
  detail TEXT,
  raw_payload JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS interventions (
  tenant_id TEXT NOT NULL DEFAULT 'default',
  id TEXT NOT NULL,
  task_id TEXT,
  learner_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  workflow_id TEXT,
  title TEXT NOT NULL,
  subject TEXT,
  module_code TEXT,
  weak_topic TEXT,
  score_before DOUBLE PRECISION,
  score_after DOUBLE PRECISION,
  quiz_id TEXT,
  quiz_passed BOOLEAN,
  outcome TEXT NOT NULL DEFAULT 'sent',
  payload JSONB NOT NULL,
  approved_at TIMESTAMPTZ,
  sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  PRIMARY KEY (tenant_id, id)
);

CREATE TABLE IF NOT EXISTS inbox_messages (
  tenant_id TEXT NOT NULL DEFAULT 'default',
  id TEXT NOT NULL,
  learner_id TEXT,
  to_email TEXT NOT NULL,
  to_name TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  link TEXT,
  delivery TEXT NOT NULL,
  task_id TEXT,
  deliverable_id TEXT,
  payload JSONB,
  sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, id)
);

CREATE TABLE IF NOT EXISTS workflows (
  tenant_id TEXT NOT NULL DEFAULT 'default',
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  office_name TEXT NOT NULL,
  description TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  trigger_type TEXT NOT NULL,
  threshold DOUBLE PRECISION,
  channel TEXT DEFAULT 'email',
  goal_template TEXT NOT NULL,
  instructions TEXT NOT NULL DEFAULT '',
  follow_up_cadence JSONB NOT NULL,
  graph JSONB NOT NULL DEFAULT '{}'::jsonb,
  runs INTEGER NOT NULL DEFAULT 0,
  last_run_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, id)
);

CREATE TABLE IF NOT EXISTS follow_up_cases (
  tenant_id TEXT NOT NULL DEFAULT 'default',
  id TEXT NOT NULL,
  learner_id TEXT NOT NULL,
  learner_name TEXT NOT NULL,
  learner_email TEXT NOT NULL,
  cohort TEXT NOT NULL DEFAULT '',
  workflow_id TEXT,
  workflow_name TEXT NOT NULL,
  trigger_kind TEXT NOT NULL,
  reason TEXT NOT NULL,
  link TEXT,
  module_code TEXT,
  topic TEXT,
  attempts INTEGER NOT NULL DEFAULT 1,
  max_attempts INTEGER,
  interval_hours INTEGER NOT NULL DEFAULT 48,
  repeat_forever BOOLEAN NOT NULL DEFAULT TRUE,
  next_due_at TIMESTAMPTZ NOT NULL,
  last_sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  status TEXT NOT NULL DEFAULT 'active',
  history JSONB NOT NULL DEFAULT '[]'::jsonb,
  PRIMARY KEY (tenant_id, id)
);

CREATE TABLE IF NOT EXISTS tenant_snapshots (
  tenant_id TEXT PRIMARY KEY,
  metrics JSONB NOT NULL DEFAULT '{}'::jsonb,
  tasks JSONB NOT NULL DEFAULT '[]'::jsonb,
  feed JSONB NOT NULL DEFAULT '[]'::jsonb,
  pending_outreach JSONB NOT NULL DEFAULT '[]'::jsonb,
  moodle_sync_meta JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Small per-workspace documents: agent runs, data-source records, leads.
-- Files people upload to the content bank (PDF guides, WhatsApp exports).
CREATE TABLE IF NOT EXISTS tenant_files (
  tenant_id TEXT NOT NULL,
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  data BYTEA NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, id)
);

CREATE TABLE IF NOT EXISTS tenant_kv (
  tenant_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, key)
);

-- Upgrade pre-existing single-tenant tables safely before indexing on tenant_id
ALTER TABLE learners ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE learners ADD COLUMN IF NOT EXISTS missed_assignments INTEGER DEFAULT 0;
ALTER TABLE learners ADD COLUMN IF NOT EXISTS payment_status TEXT DEFAULT 'ok';
ALTER TABLE learners ADD COLUMN IF NOT EXISTS source TEXT DEFAULT 'sandbox';
ALTER TABLE learners ADD COLUMN IF NOT EXISTS profile_data JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE tenant_snapshots ADD COLUMN IF NOT EXISTS moodle_sync_meta JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE lms_events ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE lms_events ADD COLUMN IF NOT EXISTS missed_assignments INTEGER;
ALTER TABLE lms_events ADD COLUMN IF NOT EXISTS payment_status TEXT;
ALTER TABLE interventions ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE interventions ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ;
ALTER TABLE inbox_messages ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE workflows ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE workflows ADD COLUMN IF NOT EXISTS channel TEXT DEFAULT 'email';
ALTER TABLE workflows ADD COLUMN IF NOT EXISTS graph JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS workspace_config JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE follow_up_cases ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'default';

DO $$
DECLARE
  t TEXT;
  pk_name TEXT;
  pk_cols INT;
BEGIN
  FOREACH t IN ARRAY ARRAY['learners', 'interventions', 'inbox_messages', 'workflows', 'follow_up_cases']
  LOOP
    SELECT c.conname, array_length(c.conkey, 1)
      INTO pk_name, pk_cols
      FROM pg_constraint c
      JOIN pg_class rel ON rel.oid = c.conrelid
     WHERE rel.relnamespace = current_schema()::regnamespace
       AND rel.relname = t
       AND c.contype = 'p'
     LIMIT 1;
    IF pk_name IS NOT NULL AND pk_cols = 1 THEN
      EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', t, pk_name);
      EXECUTE format('ALTER TABLE %I ADD PRIMARY KEY (tenant_id, id)', t);
    END IF;
  END LOOP;
END $$;

CREATE INDEX IF NOT EXISTS idx_users_tenant ON users (tenant_id);
CREATE INDEX IF NOT EXISTS idx_lms_events_tenant_learner_created ON lms_events (tenant_id, learner_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_interventions_tenant_learner_sent ON interventions (tenant_id, learner_id, sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_inbox_messages_tenant_sent ON inbox_messages (tenant_id, sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_follow_up_cases_tenant_learner_status ON follow_up_cases (tenant_id, learner_id, status);
