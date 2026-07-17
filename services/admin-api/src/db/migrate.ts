import type { DbClient } from "./client.js";

export async function runMigrations(db: DbClient): Promise<void> {
  await db.query(`
    CREATE EXTENSION IF NOT EXISTS pgcrypto;

    CREATE TABLE IF NOT EXISTS provider_configs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name TEXT NOT NULL,
      category TEXT NOT NULL CHECK (category IN ('realtime','text','asr','tts')),
      protocol TEXT NOT NULL CHECK (protocol IN ('openai','openai-compatible','gemini','custom')),
      enabled BOOLEAN NOT NULL DEFAULT true,
      base_url TEXT NOT NULL,
      model TEXT NOT NULL,
      voice TEXT,
      api_key_ciphertext TEXT,
      api_key_iv TEXT,
      api_key_auth_tag TEXT,
      priority INTEGER NOT NULL DEFAULT 100,
      settings JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS system_settings (
      key TEXT PRIMARY KEY,
      value JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}
