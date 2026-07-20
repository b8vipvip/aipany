import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import type { PersonRecord, SpeakerIdentityScope, SpeakerMatch, VoiceProfile } from "./types.js";
import type {
  AddVoiceSampleInput,
  SpeakerConsentState,
  SpeakerIdentityStore,
} from "./speaker-identity-store.js";

export interface PrivacyAwareSpeakerIdentityStoreOptions {
  delegate: SpeakerIdentityStore;
  connectionString: string;
  ssl?: boolean;
  maxPoolSize?: number;
}

/**
 * 在持久化 Identity Store 外增加 consent + audit 能力。
 * 生物识别数据本身仍由底层 PostgresSpeakerIdentityStore 负责加密；
 * 本层只记录授权状态和不含 embedding 的安全审计元数据。
 */
export class PrivacyAwareSpeakerIdentityStore implements SpeakerIdentityStore {
  private readonly pool: Pool;

  constructor(private readonly options: PrivacyAwareSpeakerIdentityStoreOptions) {
    this.pool = new Pool({
      connectionString: options.connectionString,
      max: options.maxPoolSize ?? 4,
      ssl: options.ssl ? { rejectUnauthorized: false } : undefined,
    });
  }

  async createPerson(
    scope: SpeakerIdentityScope,
    input: { name: string; relation?: string; isOwner?: boolean },
  ): Promise<PersonRecord> {
    const person = await this.options.delegate.createPerson(scope, input);
    await this.audit(scope, "person.created", person.id, {
      name: person.name,
      relation: person.relation,
      isOwner: person.isOwner,
    });
    return person;
  }

  getPerson(scope: SpeakerIdentityScope, personId: string) {
    return this.options.delegate.getPerson(scope, personId);
  }

  listPeople(scope: SpeakerIdentityScope) {
    return this.options.delegate.listPeople(scope);
  }

  getProfileByPerson(scope: SpeakerIdentityScope, personId: string) {
    return this.options.delegate.getProfileByPerson(scope, personId);
  }

  async addVoiceSample(scope: SpeakerIdentityScope, input: AddVoiceSampleInput): Promise<VoiceProfile> {
    const profile = await this.options.delegate.addVoiceSample(scope, input);
    await this.audit(scope, "voice_sample.added", input.personId, {
      profileId: profile.id,
      sampleCount: profile.samples.length,
      status: profile.status,
      quality: input.quality,
      environment: input.environment,
      proximity: input.proximity,
      sourceSessionId: input.sourceSessionId,
    });
    return profile;
  }

  identify(scope: SpeakerIdentityScope, embedding: number[]): Promise<SpeakerMatch> | SpeakerMatch {
    return this.options.delegate.identify(scope, embedding);
  }

  async deletePerson(scope: SpeakerIdentityScope, personId: string): Promise<boolean> {
    const deleted = await this.options.delegate.deletePerson(scope, personId);
    if (deleted) await this.audit(scope, "person.deleted", personId);
    return deleted;
  }

  async deleteAllPeople(scope: SpeakerIdentityScope): Promise<number> {
    const result = await this.pool.query<{ id: string }>(
      `DELETE FROM persons
       WHERE tenant_id = $1 AND user_id = $2
       RETURNING id`,
      [scope.tenantId, scope.userId],
    );
    await this.audit(scope, "identity.all_deleted", undefined, { count: result.rowCount ?? 0 });
    return result.rowCount ?? 0;
  }

  async getConsent(scope: SpeakerIdentityScope): Promise<SpeakerConsentState> {
    const result = await this.pool.query<{
      granted: boolean;
      granted_at: Date | string | null;
      revoked_at: Date | string | null;
      updated_at: Date | string;
      actor_id: string | null;
    }>(
      `SELECT granted, granted_at, revoked_at, updated_at, actor_id
       FROM speaker_consents
       WHERE tenant_id = $1 AND user_id = $2`,
      [scope.tenantId, scope.userId],
    );
    const row = result.rows[0];
    if (!row) return { granted: false, updatedAt: 0 };
    return {
      granted: row.granted,
      grantedAt: row.granted_at ? toMillis(row.granted_at) : undefined,
      revokedAt: row.revoked_at ? toMillis(row.revoked_at) : undefined,
      updatedAt: toMillis(row.updated_at),
      actorId: row.actor_id ?? undefined,
    };
  }

  async setConsent(scope: SpeakerIdentityScope, granted: boolean, actorId?: string): Promise<SpeakerConsentState> {
    const result = await this.pool.query<{
      granted: boolean;
      granted_at: Date | string | null;
      revoked_at: Date | string | null;
      updated_at: Date | string;
      actor_id: string | null;
    }>(
      `INSERT INTO speaker_consents (
         tenant_id, user_id, granted, granted_at, revoked_at, actor_id, updated_at
       ) VALUES (
         $1, $2, $3,
         CASE WHEN $3 THEN NOW() ELSE NULL END,
         CASE WHEN $3 THEN NULL ELSE NOW() END,
         $4, NOW()
       )
       ON CONFLICT (tenant_id, user_id) DO UPDATE SET
         granted = EXCLUDED.granted,
         granted_at = CASE
           WHEN EXCLUDED.granted THEN NOW()
           ELSE speaker_consents.granted_at
         END,
         revoked_at = CASE WHEN EXCLUDED.granted THEN NULL ELSE NOW() END,
         actor_id = EXCLUDED.actor_id,
         updated_at = NOW()
       RETURNING granted, granted_at, revoked_at, updated_at, actor_id`,
      [scope.tenantId, scope.userId, granted, actorId ?? null],
    );
    const row = result.rows[0];
    if (!row) throw new Error("更新 Speaker Consent 失败");
    await this.audit(scope, granted ? "consent.granted" : "consent.revoked", undefined, { actorId });
    return {
      granted: row.granted,
      grantedAt: row.granted_at ? toMillis(row.granted_at) : undefined,
      revokedAt: row.revoked_at ? toMillis(row.revoked_at) : undefined,
      updatedAt: toMillis(row.updated_at),
      actorId: row.actor_id ?? undefined,
    };
  }

  async close(): Promise<void> {
    await this.options.delegate.close?.();
    await this.pool.end();
  }

  private async audit(
    scope: SpeakerIdentityScope,
    action: string,
    personId?: string,
    details: Record<string, unknown> = {},
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO speaker_audit_log (
         id, tenant_id, user_id, person_id, action, details
       ) VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
      [randomUUID(), scope.tenantId, scope.userId, personId ?? null, action, JSON.stringify(details)],
    );
  }
}

function toMillis(value: Date | string): number {
  const date = value instanceof Date ? value : new Date(value);
  return date.getTime();
}
