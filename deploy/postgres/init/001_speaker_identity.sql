CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS persons (
  id UUID PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  relation TEXT,
  is_owner BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS persons_identity_scope_idx
  ON persons (tenant_id, user_id, created_at);

CREATE TABLE IF NOT EXISTS speaker_profiles (
  id UUID PRIMARY KEY,
  person_id UUID NOT NULL UNIQUE REFERENCES persons(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('learning', 'confirmed')),
  confidence DOUBLE PRECISION NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  centroid_encrypted BYTEA NOT NULL,
  centroid_search_embedding VECTOR NOT NULL,
  embedding_dimensions INTEGER NOT NULL CHECK (embedding_dimensions > 1),
  sample_count INTEGER NOT NULL DEFAULT 0 CHECK (sample_count >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS speaker_profiles_person_idx
  ON speaker_profiles (person_id);

CREATE TABLE IF NOT EXISTS speaker_samples (
  id UUID PRIMARY KEY,
  profile_id UUID NOT NULL REFERENCES speaker_profiles(id) ON DELETE CASCADE,
  encrypted_embedding BYTEA NOT NULL,
  quality DOUBLE PRECISION NOT NULL CHECK (quality >= 0 AND quality <= 1),
  environment TEXT,
  proximity TEXT,
  source_session_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS speaker_samples_profile_created_idx
  ON speaker_samples (profile_id, created_at);

COMMENT ON COLUMN speaker_profiles.centroid_encrypted IS
  'AES-256-GCM encrypted canonical speaker centroid; never store canonical embedding in plaintext.';
COMMENT ON COLUMN speaker_profiles.centroid_search_embedding IS
  'Keyed orthogonal projection for pgvector candidate retrieval. Treat as sensitive derived biometric data.';
COMMENT ON COLUMN speaker_samples.encrypted_embedding IS
  'AES-256-GCM encrypted speaker embedding. Raw registration audio is not stored by this schema.';
