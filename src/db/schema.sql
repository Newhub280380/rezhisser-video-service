-- Rezhisser production schema (PostgreSQL 13+). Idempotent: safe to run on
-- every deploy (npm run db:migrate or automatically at startup).

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  locale TEXT NOT NULL DEFAULT 'ru',
  tier TEXT NOT NULL DEFAULT 'free' CHECK (tier IN ('free', 'pro', 'studio')),
  subscription_expires_at TIMESTAMPTZ,
  period_start TIMESTAMPTZ NOT NULL DEFAULT now(),
  period_videos_used INTEGER NOT NULL DEFAULT 0 CHECK (period_videos_used >= 0),
  credits INTEGER NOT NULL DEFAULT 0 CHECK (credits >= 0),
  token_version INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS password_resets (
  token_hash TEXT PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS video_jobs (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('queued', 'processing', 'succeeded', 'failed', 'expired')),
  provider TEXT NOT NULL,
  provider_task_id TEXT,
  model TEXT,
  prompt TEXT NOT NULL,
  brief JSONB,
  library_item_id TEXT,
  aspect TEXT,
  duration_seconds INTEGER,
  has_image BOOLEAN NOT NULL DEFAULT false,
  billing_source TEXT NOT NULL CHECK (billing_source IN ('demo', 'subscription', 'credits')),
  cost_usd NUMERIC(10, 4) NOT NULL DEFAULT 0,
  video_key TEXT,
  video_url TEXT,
  video_bytes BIGINT,
  error JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS video_jobs_user_created_idx ON video_jobs (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS video_jobs_status_idx ON video_jobs (status);
CREATE INDEX IF NOT EXISTS video_jobs_expires_idx ON video_jobs (expires_at) WHERE expires_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS payments (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('yookassa', 'stripe')),
  provider_payment_id TEXT,
  provider_reference TEXT,
  product TEXT NOT NULL,
  amount_minor BIGINT NOT NULL CHECK (amount_minor > 0),
  currency TEXT NOT NULL CHECK (currency IN ('RUB', 'KZT', 'USD', 'CNY')),
  status TEXT NOT NULL CHECK (status IN ('pending', 'succeeded', 'canceled', 'refunded')),
  confirmation_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  paid_at TIMESTAMPTZ,
  refunded_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS payments_provider_id_idx ON payments (provider, provider_payment_id) WHERE provider_payment_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS payments_user_created_idx ON payments (user_id, created_at DESC);

-- Usage ledger: generations, refunded generations, credit grants and
-- subscription changes. Together with payments this is the billing history.
CREATE TABLE IF NOT EXISTS usage_events (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  source TEXT,
  amount INTEGER NOT NULL DEFAULT 0,
  job_id UUID,
  payment_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS usage_events_user_created_idx ON usage_events (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS projects (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('project', 'favorite')),
  title TEXT NOT NULL,
  library_item_id TEXT,
  prompt TEXT,
  brief JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS projects_user_created_idx ON projects (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS automation_tasks (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  instruction TEXT NOT NULL,
  region TEXT NOT NULL DEFAULT 'US',
  enabled BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS automation_tasks_user_created_idx ON automation_tasks (user_id, created_at DESC);

-- Run history for automation tasks (Owl Browser or local simulation).
CREATE TABLE IF NOT EXISTS automation_runs (
  id UUID PRIMARY KEY,
  task_id UUID NOT NULL REFERENCES automation_tasks(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  task_name TEXT NOT NULL,
  url TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed')),
  executor TEXT NOT NULL,
  simulated BOOLEAN NOT NULL DEFAULT false,
  provider_job_id TEXT,
  summary TEXT,
  log JSONB,
  error JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS automation_runs_user_created_idx ON automation_runs (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS automation_runs_task_created_idx ON automation_runs (task_id, created_at DESC);
-- At most one active run per task, enforced atomically across instances.
CREATE UNIQUE INDEX IF NOT EXISTS automation_runs_one_active_idx ON automation_runs (task_id) WHERE status IN ('queued', 'running');

-- ---- Film pipeline (SGLang plan -> Ray render -> ReCaVSR upscale -> mix) ----

-- One row per film job: a template reel (3–4 scenes) or a long film
-- (24–36 scenes), rendered scene by scene and assembled into one MP4.
CREATE TABLE IF NOT EXISTS film_jobs (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN (
    'queued', 'planning', 'provisioning', 'rendering', 'upscaling',
    'assembling', 'succeeded', 'failed', 'canceled', 'needs_attention'
  )),
  stage TEXT,
  template_id TEXT,
  scene_count INTEGER,
  aspect TEXT,
  base_resolution TEXT,
  target_resolution TEXT,
  engine TEXT,
  plan JSONB,
  plan_hash TEXT,
  audio JSONB,
  options JSONB,
  infra JSONB,
  cost_usd NUMERIC(10, 4) NOT NULL DEFAULT 0,
  progress INTEGER NOT NULL DEFAULT 0,
  output_key TEXT,
  output_url TEXT,
  output_bytes BIGINT,
  error JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS film_jobs_user_created_idx ON film_jobs (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS film_jobs_status_idx ON film_jobs (status);

CREATE TABLE IF NOT EXISTS film_shots (
  id UUID PRIMARY KEY,
  job_id UUID NOT NULL REFERENCES film_jobs(id) ON DELETE CASCADE,
  scene_number INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'rendering', 'upscaling', 'ready', 'failed', 'skipped')),
  prompt TEXT,
  params JSONB,
  attempts INTEGER NOT NULL DEFAULT 0,
  provider_task_id TEXT,
  clip_key TEXT,
  clip_url TEXT,
  -- Local file produced by the renderer, used by ffmpeg for the assembly.
  local_path TEXT,
  upscaled_key TEXT,
  duration_seconds NUMERIC(6, 2),
  cost_usd NUMERIC(10, 4) NOT NULL DEFAULT 0,
  error JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS film_shots_job_scene_idx ON film_shots (job_id, scene_number);
CREATE INDEX IF NOT EXISTS film_shots_job_idx ON film_shots (job_id, scene_number);

-- Every rented GPU cluster is recorded before it is used, so a crashed
-- process cannot silently leak a paid machine: at the next start, clusters
-- still marked open are torn down.
CREATE TABLE IF NOT EXISTS infra_leases (
  id UUID PRIMARY KEY,
  job_id UUID REFERENCES film_jobs(id) ON DELETE SET NULL,
  provider TEXT NOT NULL,
  cluster_name TEXT NOT NULL,
  region TEXT,
  accelerator TEXT,
  nodes INTEGER NOT NULL DEFAULT 1,
  hourly_usd NUMERIC(10, 4) NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK (status IN ('provisioning', 'running', 'tearing_down', 'torn_down', 'leak_suspected')),
  detail JSONB,
  launched_at TIMESTAMPTZ,
  teardown_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS infra_leases_status_idx ON infra_leases (status);
CREATE INDEX IF NOT EXISTS infra_leases_job_idx ON infra_leases (job_id);

-- Content library mirror (source of truth: src/library/*.json, upserted by
-- the migration so the data can be queried or joined in SQL).
CREATE TABLE IF NOT EXISTS library_items (
  id TEXT PRIMARY KEY,
  region TEXT NOT NULL,
  country TEXT NOT NULL,
  language TEXT NOT NULL,
  category TEXT NOT NULL,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  trend TEXT NOT NULL,
  data JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS library_items_filter_idx ON library_items (region, language, category);
