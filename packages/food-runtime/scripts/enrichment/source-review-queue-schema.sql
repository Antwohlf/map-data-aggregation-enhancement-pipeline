-- Durable local review queue for source records that should not be imported
-- automatically.
--
-- Local-first rollout:
--   psql pizza_enrichment < scripts/enrichment/source-review-queue-schema.sql

CREATE TABLE IF NOT EXISTS source_review_queue (
  id BIGSERIAL PRIMARY KEY,

  entity_type TEXT NOT NULL CHECK (entity_type IN ('pizza', 'taco')),
  review_kind TEXT NOT NULL CHECK (review_kind IN ('ambiguous', 'likely_new')),

  source TEXT NOT NULL,
  source_id TEXT NOT NULL,
  source_name TEXT,
  source_url TEXT,
  source_data JSONB NOT NULL DEFAULT '{}'::jsonb,

  nearest_place_id BIGINT,
  nearest_google_place_id TEXT,
  nearest_place_name TEXT,
  nearest_distance_m NUMERIC(10, 3),
  nearest_name_score NUMERIC(8, 4),
  review_reason TEXT,

  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'accepted', 'linked', 'rejected', 'ignored')),
  decision TEXT,
  canonical_place_id BIGINT,
  reviewer_notes TEXT,
  reviewed_at TIMESTAMPTZ,
  reviewed_by TEXT,

  report_file TEXT,
  report_generated_at TIMESTAMPTZ,
  imported_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (entity_type, source, source_id, review_kind)
);

CREATE INDEX IF NOT EXISTS idx_source_review_queue_status
  ON source_review_queue(entity_type, status, review_kind);

CREATE INDEX IF NOT EXISTS idx_source_review_queue_source
  ON source_review_queue(source, source_id);

CREATE INDEX IF NOT EXISTS idx_source_review_queue_nearest_place
  ON source_review_queue(entity_type, nearest_place_id);

-- Audit-only history for every review decision. This is local operator state,
-- not a second provenance model and never syncs to Supabase.
CREATE TABLE IF NOT EXISTS source_review_decision_history (
  id BIGSERIAL PRIMARY KEY,
  review_queue_id BIGINT NOT NULL,
  entity_type TEXT NOT NULL,
  source TEXT NOT NULL,
  source_id TEXT NOT NULL,
  previous_review_kind TEXT,
  previous_status TEXT,
  previous_decision TEXT,
  previous_canonical_place_id BIGINT,
  review_kind TEXT NOT NULL,
  status TEXT NOT NULL,
  decision TEXT,
  canonical_place_id BIGINT,
  action TEXT NOT NULL,
  reviewer_notes TEXT,
  reviewed_by TEXT,
  canonical_before JSONB,
  canonical_after JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE source_review_decision_history
  ADD COLUMN IF NOT EXISTS canonical_before JSONB,
  ADD COLUMN IF NOT EXISTS canonical_after JSONB;

-- AI suggestions are advisory local metadata. They never change queue status,
-- canonical fields, provenance, or Supabase.
CREATE TABLE IF NOT EXISTS source_review_ai_assessments (
  id BIGSERIAL PRIMARY KEY,
  review_queue_id BIGINT NOT NULL,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('pizza', 'taco')),
  model TEXT NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('same_place', 'different_place', 'business_replacement', 'uncertain')),
  confidence NUMERIC(5, 4) NOT NULL DEFAULT 0,
  reason TEXT,
  supporting_evidence JSONB NOT NULL DEFAULT '[]'::jsonb,
  needs_human_review BOOLEAN NOT NULL DEFAULT TRUE,
  decision_origin TEXT NOT NULL DEFAULT 'ollama',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (review_queue_id, model)
);

CREATE INDEX IF NOT EXISTS idx_source_review_ai_assessments_queue
  ON source_review_ai_assessments(review_queue_id, created_at DESC);
