CREATE TABLE IF NOT EXISTS speaker_consents (
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  granted BOOLEAN NOT NULL DEFAULT FALSE,
  granted_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  actor_id TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, user_id)
);

CREATE TABLE IF NOT EXISTS speaker_audit_log (
  id UUID PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  person_id UUID,
  action TEXT NOT NULL,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS speaker_audit_scope_time_idx
  ON speaker_audit_log (tenant_id, user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS speaker_audit_person_idx
  ON speaker_audit_log (person_id, created_at DESC)
  WHERE person_id IS NOT NULL;
