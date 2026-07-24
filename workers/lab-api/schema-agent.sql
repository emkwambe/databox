-- ============================================================
-- Schema: Claimable Database Agent API (Day 1)
-- Run against D1 realitydb-labs (1fa51a0c-c851-4cec-8e91-ac1ee2079ff8)
--
-- Two tables:
--   agent_api_keys   — identity + tier + quota for agent callers
--   agent_databases  — claim records (the "claimable databases")
--
-- Design ref: CLAIMABLE-DATABASE-AGENT-API-DESIGN.md
-- Naming per Day-1 spec: agent_api_keys / agent_databases /
--   POST /v1/agent/databases. Semantics mirror the doc's /v1/claims
--   lifecycle (PENDING -> READY -> RELEASED/FAILED).
-- ============================================================

-- ── agent_api_keys ──────────────────────────────────────────
-- Raw keys are NEVER stored. We keep the SHA-256 hash (for lookup)
-- and a short prefix (for display). One row per issued key.
CREATE TABLE IF NOT EXISTS agent_api_keys (
  id                       TEXT PRIMARY KEY,              -- akey-xxxxxxxx
  key_hash                 TEXT NOT NULL,                 -- SHA-256 hex of the raw key
  key_prefix               TEXT NOT NULL,                 -- e.g. rdb_agent_ab12cd34 (display only)
  name                     TEXT,                          -- human label
  owner_id                 TEXT NOT NULL,                 -- user/org that owns the key
  tier                     TEXT NOT NULL DEFAULT 'free',  -- free | developer | team | agent
  monthly_claim_limit      INTEGER NOT NULL DEFAULT 50,   -- claims allowed per period
  claims_used_this_period  INTEGER NOT NULL DEFAULT 0,
  max_rows                 INTEGER NOT NULL DEFAULT 5000, -- ceiling per claim
  max_ttl_seconds          INTEGER NOT NULL DEFAULT 1800, -- ceiling per claim
  status                   TEXT NOT NULL DEFAULT 'active',-- active | revoked
  period_start             TEXT,                          -- ISO; monthly quota window start
  created_at               TEXT NOT NULL,
  last_used_at             TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_api_keys_hash  ON agent_api_keys(key_hash);
CREATE INDEX        IF NOT EXISTS idx_agent_api_keys_owner ON agent_api_keys(owner_id);
CREATE INDEX        IF NOT EXISTS idx_agent_api_keys_status ON agent_api_keys(status);

-- ── agent_databases ─────────────────────────────────────────
-- One row per claimed database. Lifecycle status mirrors the
-- design doc: PENDING -> READY -> RELEASED (or FAILED).
CREATE TABLE IF NOT EXISTS agent_databases (
  id                 TEXT PRIMARY KEY,              -- adb-xxxxxxxx (the claim_id)
  api_key_id         TEXT NOT NULL,                 -- FK -> agent_api_keys.id
  owner_id           TEXT NOT NULL,
  template           TEXT NOT NULL,
  rows               INTEGER NOT NULL,
  seed               INTEGER,
  status             TEXT NOT NULL DEFAULT 'PENDING',-- PENDING | READY | FAILED | RELEASED
  neon_branch_id     TEXT,
  neon_endpoint_id   TEXT,
  connection_string  TEXT,                          -- direct (unmasked); returned only to the claimant
  tables_count       INTEGER,
  rows_seeded        INTEGER,
  idempotency_key    TEXT,                          -- dedupes retries within an api_key
  error_message      TEXT,
  created_at         TEXT NOT NULL,
  ready_at           TEXT,
  expires_at         TEXT NOT NULL,
  released_at        TEXT
);

CREATE INDEX IF NOT EXISTS idx_agent_databases_owner  ON agent_databases(owner_id);
CREATE INDEX IF NOT EXISTS idx_agent_databases_status ON agent_databases(status);
CREATE INDEX IF NOT EXISTS idx_agent_databases_apikey ON agent_databases(api_key_id);
CREATE INDEX IF NOT EXISTS idx_agent_databases_expiry ON agent_databases(status, expires_at);

-- Idempotency guard: a given (api_key_id, idempotency_key) maps to at
-- most one claim, so a retried request returns the same database instead
-- of provisioning a second Neon branch.
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_databases_idem
  ON agent_databases(api_key_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- ── agent_rate_limits ───────────────────────────────────────
-- Sliding-window rate limiting per key (Day 2). window_start is the
-- unix-epoch-seconds start of a fixed 60s bucket; the limiter reads the
-- current + previous bucket and weights the previous one by overlap to
-- approximate a sliding window. Rows for old windows are pruned on read.
CREATE TABLE IF NOT EXISTS agent_rate_limits (
  key_id        TEXT NOT NULL,
  window_start  INTEGER NOT NULL,   -- unix epoch seconds, floored to 60s
  request_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (key_id, window_start)
);

CREATE INDEX IF NOT EXISTS idx_agent_rate_limits_window ON agent_rate_limits(window_start);