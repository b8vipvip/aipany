import { createCipheriv, createDecipheriv, createHmac, randomBytes, randomUUID } from "node:crypto";
import { Pool, type PoolClient, type QueryResultRow } from "pg";
import type { PersonRecord, SpeakerIdentityScope, SpeakerMatch, VoiceProfile, VoiceSample } from "./types.js";
import {
  applyProfileStatistics,
  clamp,
  createVoiceSample,
  type AddVoiceSampleInput,
  type ResolvedSpeakerIdentityStoreOptions,
  resolveSpeakerIdentityStoreOptions,
  scoreSpeakerProfile,
  type SpeakerIdentityStore,
  type SpeakerIdentityStoreOptions,
  validateEmbedding,
  validateScope,
} from "./speaker-identity-store.js";

export interface PostgresSpeakerIdentityStoreOptions {
  connectionString: string;
  encryptionKey: string;
  ssl?: boolean;
  maxPoolSize?: number;
  matchCandidateCount?: number;
  identity?: SpeakerIdentityStoreOptions;
}

interface PersonRow extends QueryResultRow {
  id: string;
  tenant_id: string;
  user_id: string;
  name: string;
  relation: string | null;
  is_owner: boolean;
  voice_profile_id: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface ProfileRow extends QueryResultRow {
  id: string;
  person_id: string;
  status: "learning" | "confirmed";
  confidence: number | string;
  centroid_encrypted: Buffer;
  embedding_dimensions: number;
  sample_count: number;
  created_at: Date | string;
  updated_at: Date | string;
}

interface SampleRow extends QueryResultRow {
  id: string;
  profile_id: string;
  encrypted_embedding: Buffer;
  quality: number | string;
  environment: string | null;
  proximity: VoiceSample["proximity"] | null;
  source_session_id: string | null;
  created_at: Date | string;
}

interface CandidateRow extends QueryResultRow {
  id: string;
  tenant_id: string;
  user_id: string;
  name: string;
  relation: string | null;
  is_owner: boolean;
  voice_profile_id: string;
  created_at: Date | string;
  updated_at: Date | string;
  profile_id: string;
  profile_person_id: string;
  profile_status: "learning" | "confirmed";
  profile_confidence: number | string;
  centroid_encrypted: Buffer;
  embedding_dimensions: number;
  sample_count: number;
  profile_created_at: Date | string;
  profile_updated_at: Date | string;
}

/**
 * PostgreSQL + pgvector Speaker Identity Store。
 *
 * canonical centroid/sample embedding 使用 AES-256-GCM 加密后保存到 BYTEA。
 * pgvector 只保存按 tenant/user 作用域派生的正交投影，用于候选召回；
 * 最终身份判断仍解密候选并复用原始多样本评分逻辑。
 */
export class PostgresSpeakerIdentityStore implements SpeakerIdentityStore {
  private readonly pool: Pool;
  private readonly codec: EncryptedEmbeddingCodec;
  private readonly identityOptions: ResolvedSpeakerIdentityStoreOptions;
  private readonly matchCandidateCount: number;

  constructor(options: PostgresSpeakerIdentityStoreOptions) {
    if (!options.connectionString.trim()) throw new Error("PostgreSQL connectionString 不能为空");
    this.pool = new Pool({
      connectionString: options.connectionString,
      max: options.maxPoolSize ?? 10,
      ssl: options.ssl ? { rejectUnauthorized: false } : undefined,
    });
    this.codec = new EncryptedEmbeddingCodec(options.encryptionKey);
    this.identityOptions = resolveSpeakerIdentityStoreOptions(options.identity);
    this.matchCandidateCount = Math.max(1, Math.min(100, options.matchCandidateCount ?? 20));
  }

  async createPerson(
    scope: SpeakerIdentityScope,
    input: { name: string; relation?: string; isOwner?: boolean },
  ): Promise<PersonRecord> {
    validateScope(scope);
    const name = input.name.trim();
    if (!name) throw new Error("人物名称不能为空");
    const result = await this.pool.query<PersonRow>(
      `INSERT INTO persons (id, tenant_id, user_id, name, relation, is_owner)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, tenant_id, user_id, name, relation, is_owner,
         NULL::uuid AS voice_profile_id, created_at, updated_at`,
      [randomUUID(), scope.tenantId, scope.userId, name, input.relation?.trim() || null, input.isOwner ?? false],
    );
    const row = result.rows[0];
    if (!row) throw new Error("创建人物失败");
    return mapPerson(row);
  }

  async getPerson(scope: SpeakerIdentityScope, personId: string): Promise<PersonRecord | undefined> {
    const result = await this.pool.query<PersonRow>(
      `SELECT p.id, p.tenant_id, p.user_id, p.name, p.relation, p.is_owner,
              sp.id AS voice_profile_id, p.created_at, p.updated_at
       FROM persons p
       LEFT JOIN speaker_profiles sp ON sp.person_id = p.id
       WHERE p.id = $1 AND p.tenant_id = $2 AND p.user_id = $3`,
      [personId, scope.tenantId, scope.userId],
    );
    return result.rows[0] ? mapPerson(result.rows[0]) : undefined;
  }

  async listPeople(scope: SpeakerIdentityScope): Promise<PersonRecord[]> {
    const result = await this.pool.query<PersonRow>(
      `SELECT p.id, p.tenant_id, p.user_id, p.name, p.relation, p.is_owner,
              sp.id AS voice_profile_id, p.created_at, p.updated_at
       FROM persons p
       LEFT JOIN speaker_profiles sp ON sp.person_id = p.id
       WHERE p.tenant_id = $1 AND p.user_id = $2
       ORDER BY p.created_at ASC`,
      [scope.tenantId, scope.userId],
    );
    return result.rows.map(mapPerson);
  }

  async getProfileByPerson(scope: SpeakerIdentityScope, personId: string): Promise<VoiceProfile | undefined> {
    const client = await this.pool.connect();
    try {
      const person = await this.getPersonWithClient(client, scope, personId);
      if (!person?.voiceProfileId) return undefined;
      const profileRow = await this.getProfileRow(client, person.voiceProfileId);
      if (!profileRow) return undefined;
      const samples = await this.loadSamples(client, scope, profileRow.id);
      return this.mapProfile(scope, profileRow, samples);
    } finally {
      client.release();
    }
  }

  async addVoiceSample(scope: SpeakerIdentityScope, input: AddVoiceSampleInput): Promise<VoiceProfile> {
    validateScope(scope);
    validateEmbedding(input.embedding);
    const quality = clamp(input.quality ?? 1, 0, 1);
    if (quality < this.identityOptions.minimumSampleQuality) {
      throw new Error(`声纹样本质量过低：${quality.toFixed(2)}`);
    }

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const personResult = await client.query<PersonRow>(
        `SELECT id, tenant_id, user_id, name, relation, is_owner,
                NULL::uuid AS voice_profile_id, created_at, updated_at
         FROM persons
         WHERE id = $1 AND tenant_id = $2 AND user_id = $3
         FOR UPDATE`,
        [input.personId, scope.tenantId, scope.userId],
      );
      const personRow = personResult.rows[0];
      if (!personRow) throw new Error(`人物不存在或无权访问：${input.personId}`);

      // 锁 Person 后再读取 Profile，避免并发首样本创建出两个 Profile。
      const existing = await this.getProfileRowByPerson(client, personRow.id, true);
      if (existing && existing.embedding_dimensions !== input.embedding.length) {
        throw new Error("声纹向量维度与人物现有 Voice Profile 不一致");
      }

      const now = Date.now();
      const profileId = existing?.id ?? randomUUID();
      const samples = existing ? await this.loadSamples(client, scope, profileId) : [];
      const sample = createVoiceSample(input, quality, now);
      samples.push(sample);

      const profile: VoiceProfile = {
        id: profileId,
        personId: personRow.id,
        status: existing?.status ?? "learning",
        confidence: existing ? Number(existing.confidence) : 0,
        centroid: [...input.embedding],
        samples,
        createdAt: existing ? toMillis(existing.created_at) : now,
        updatedAt: now,
      };
      applyProfileStatistics(profile, this.identityOptions);

      const encryptedCentroid = this.codec.encrypt(profile.centroid, centroidAad(scope, profile.id));
      const searchVector = formatPgVector(
        this.codec.projectForSearch(profile.centroid, searchProjectionContext(scope)),
      );

      if (existing) {
        await client.query(
          `UPDATE speaker_profiles
           SET status = $2, confidence = $3, centroid_encrypted = $4,
               centroid_search_embedding = $5::vector, embedding_dimensions = $6,
               sample_count = $7, updated_at = NOW()
           WHERE id = $1`,
          [
            profile.id,
            profile.status,
            profile.confidence,
            encryptedCentroid,
            searchVector,
            profile.centroid.length,
            profile.samples.length,
          ],
        );
      } else {
        await client.query(
          `INSERT INTO speaker_profiles (
             id, person_id, status, confidence, centroid_encrypted,
             centroid_search_embedding, embedding_dimensions, sample_count
           ) VALUES ($1, $2, $3, $4, $5, $6::vector, $7, $8)`,
          [
            profile.id,
            profile.personId,
            profile.status,
            profile.confidence,
            encryptedCentroid,
            searchVector,
            profile.centroid.length,
            profile.samples.length,
          ],
        );
      }

      await client.query(
        `INSERT INTO speaker_samples (
           id, profile_id, encrypted_embedding, quality, environment,
           proximity, source_session_id, created_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, to_timestamp($8 / 1000.0))`,
        [
          sample.id,
          profile.id,
          this.codec.encrypt(sample.embedding, sampleAad(scope, profile.id, sample.id)),
          sample.quality,
          sample.environment ?? null,
          sample.proximity ?? null,
          sample.sourceSessionId ?? null,
          sample.createdAt,
        ],
      );
      await client.query("UPDATE persons SET updated_at = NOW() WHERE id = $1", [personRow.id]);
      await client.query("COMMIT");
      return profile;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async identify(scope: SpeakerIdentityScope, embedding: number[]): Promise<SpeakerMatch> {
    validateScope(scope);
    validateEmbedding(embedding);
    const projected = formatPgVector(
      this.codec.projectForSearch(embedding, searchProjectionContext(scope)),
    );
    const result = await this.pool.query<CandidateRow>(
      `SELECT p.id, p.tenant_id, p.user_id, p.name, p.relation, p.is_owner,
              sp.id AS voice_profile_id, p.created_at, p.updated_at,
              sp.id AS profile_id, sp.person_id AS profile_person_id,
              sp.status AS profile_status, sp.confidence AS profile_confidence,
              sp.centroid_encrypted, sp.embedding_dimensions, sp.sample_count,
              sp.created_at AS profile_created_at, sp.updated_at AS profile_updated_at
       FROM speaker_profiles sp
       JOIN persons p ON p.id = sp.person_id
       WHERE p.tenant_id = $1 AND p.user_id = $2 AND sp.embedding_dimensions = $3
       ORDER BY sp.centroid_search_embedding <=> $4::vector
       LIMIT $5`,
      [scope.tenantId, scope.userId, embedding.length, projected, this.matchCandidateCount],
    );

    let best: SpeakerMatch = { similarity: 0, confident: false };
    const client = await this.pool.connect();
    try {
      for (const row of result.rows) {
        try {
          const person = mapPerson(row);
          const samples = await this.loadSamples(client, scope, row.profile_id);
          const profile: VoiceProfile = {
            id: row.profile_id,
            personId: row.profile_person_id,
            status: row.profile_status,
            confidence: Number(row.profile_confidence),
            centroid: this.codec.decrypt(row.centroid_encrypted, centroidAad(scope, row.profile_id)),
            samples,
            createdAt: toMillis(row.profile_created_at),
            updatedAt: toMillis(row.profile_updated_at),
          };
          const candidate = scoreSpeakerProfile(profile, person, embedding, this.identityOptions.matchThreshold);
          if (candidate.similarity > best.similarity) best = candidate;
        } catch {
          // 单个损坏/无法解密的 Profile 不应阻断其它候选和实时语音主链路。
        }
      }
    } finally {
      client.release();
    }
    return best;
  }

  async deletePerson(scope: SpeakerIdentityScope, personId: string): Promise<boolean> {
    const result = await this.pool.query(
      `DELETE FROM persons WHERE id = $1 AND tenant_id = $2 AND user_id = $3`,
      [personId, scope.tenantId, scope.userId],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  private async getPersonWithClient(
    client: PoolClient,
    scope: SpeakerIdentityScope,
    personId: string,
  ): Promise<PersonRecord | undefined> {
    const result = await client.query<PersonRow>(
      `SELECT p.id, p.tenant_id, p.user_id, p.name, p.relation, p.is_owner,
              sp.id AS voice_profile_id, p.created_at, p.updated_at
       FROM persons p
       LEFT JOIN speaker_profiles sp ON sp.person_id = p.id
       WHERE p.id = $1 AND p.tenant_id = $2 AND p.user_id = $3`,
      [personId, scope.tenantId, scope.userId],
    );
    return result.rows[0] ? mapPerson(result.rows[0]) : undefined;
  }

  private async getProfileRow(client: PoolClient, profileId: string): Promise<ProfileRow | undefined> {
    const result = await client.query<ProfileRow>(
      `SELECT id, person_id, status, confidence, centroid_encrypted,
              embedding_dimensions, sample_count, created_at, updated_at
       FROM speaker_profiles WHERE id = $1`,
      [profileId],
    );
    return result.rows[0];
  }

  private async getProfileRowByPerson(
    client: PoolClient,
    personId: string,
    forUpdate = false,
  ): Promise<ProfileRow | undefined> {
    const result = await client.query<ProfileRow>(
      `SELECT id, person_id, status, confidence, centroid_encrypted,
              embedding_dimensions, sample_count, created_at, updated_at
       FROM speaker_profiles WHERE person_id = $1${forUpdate ? " FOR UPDATE" : ""}`,
      [personId],
    );
    return result.rows[0];
  }

  private async loadSamples(
    client: PoolClient,
    scope: SpeakerIdentityScope,
    profileId: string,
  ): Promise<VoiceSample[]> {
    const result = await client.query<SampleRow>(
      `SELECT id, profile_id, encrypted_embedding, quality, environment, proximity,
              source_session_id, created_at
       FROM speaker_samples WHERE profile_id = $1 ORDER BY created_at ASC`,
      [profileId],
    );
    return result.rows.map((row) => ({
      id: row.id,
      embedding: this.codec.decrypt(row.encrypted_embedding, sampleAad(scope, profileId, row.id)),
      quality: Number(row.quality),
      environment: row.environment ?? undefined,
      proximity: row.proximity ?? undefined,
      sourceSessionId: row.source_session_id ?? undefined,
      createdAt: toMillis(row.created_at),
    }));
  }

  private mapProfile(scope: SpeakerIdentityScope, row: ProfileRow, samples: VoiceSample[]): VoiceProfile {
    return {
      id: row.id,
      personId: row.person_id,
      status: row.status,
      confidence: Number(row.confidence),
      centroid: this.codec.decrypt(row.centroid_encrypted, centroidAad(scope, row.id)),
      samples,
      createdAt: toMillis(row.created_at),
      updatedAt: toMillis(row.updated_at),
    };
  }
}

export class EncryptedEmbeddingCodec {
  private static readonly VERSION = 1;
  private static readonly IV_BYTES = 12;
  private static readonly TAG_BYTES = 16;
  private readonly encryptionKey: Buffer;
  private readonly projectionKey: Buffer;
  private readonly transforms = new Map<string, { permutation: number[]; signs: number[] }>();

  constructor(encodedKey: string) {
    this.encryptionKey = decodeEncryptionKey(encodedKey);
    this.projectionKey = createHmac("sha256", this.encryptionKey)
      .update("aipany-speaker-search-projection-v1")
      .digest();
  }

  encrypt(embedding: number[], aad: string): Buffer {
    validateEmbedding(embedding);
    const iv = randomBytes(EncryptedEmbeddingCodec.IV_BYTES);
    const cipher = createCipheriv("aes-256-gcm", this.encryptionKey, iv);
    cipher.setAAD(Buffer.from(aad, "utf8"));
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(embedding), "utf8"), cipher.final()]);
    return Buffer.concat([
      Buffer.from([EncryptedEmbeddingCodec.VERSION]),
      iv,
      cipher.getAuthTag(),
      ciphertext,
    ]);
  }

  decrypt(payload: Buffer, aad: string): number[] {
    const min = 1 + EncryptedEmbeddingCodec.IV_BYTES + EncryptedEmbeddingCodec.TAG_BYTES + 1;
    if (payload.length < min || payload[0] !== EncryptedEmbeddingCodec.VERSION) {
      throw new Error("不支持或损坏的声纹密文格式");
    }
    const ivStart = 1;
    const tagStart = ivStart + EncryptedEmbeddingCodec.IV_BYTES;
    const cipherStart = tagStart + EncryptedEmbeddingCodec.TAG_BYTES;
    const decipher = createDecipheriv(
      "aes-256-gcm",
      this.encryptionKey,
      payload.subarray(ivStart, tagStart),
    );
    decipher.setAAD(Buffer.from(aad, "utf8"));
    decipher.setAuthTag(payload.subarray(tagStart, cipherStart));
    const plaintext = Buffer.concat([
      decipher.update(payload.subarray(cipherStart)),
      decipher.final(),
    ]).toString("utf8");
    const parsed: unknown = JSON.parse(plaintext);
    if (!Array.isArray(parsed) || parsed.some((value) => typeof value !== "number" || !Number.isFinite(value))) {
      throw new Error("解密后的声纹向量格式无效");
    }
    const embedding = parsed as number[];
    validateEmbedding(embedding);
    return embedding;
  }

  /** 保持 cosine 的密钥派生 signed permutation；每个 tenant/user 使用不同投影。 */
  projectForSearch(embedding: number[], context = "default"): number[] {
    validateEmbedding(embedding);
    const cacheKey = `${context}:${embedding.length}`;
    let transform = this.transforms.get(cacheKey);
    if (!transform) {
      const scopedKey = createHmac("sha256", this.projectionKey).update(context).digest();
      transform = buildOrthogonalTransform(scopedKey, embedding.length);
      this.transforms.set(cacheKey, transform);
    }
    return transform.permutation.map(
      (sourceIndex, targetIndex) => (embedding[sourceIndex] ?? 0) * (transform?.signs[targetIndex] ?? 1),
    );
  }
}

function decodeEncryptionKey(value: string): Buffer {
  const trimmed = value.trim();
  const key = /^[0-9a-fA-F]{64}$/.test(trimmed)
    ? Buffer.from(trimmed, "hex")
    : Buffer.from(trimmed, "base64");
  if (key.length !== 32) {
    throw new Error("SPEAKER_IDENTITY_ENCRYPTION_KEY 必须是 32 字节密钥的 Base64 或 64 位 Hex 表示");
  }
  return key;
}

function buildOrthogonalTransform(key: Buffer, dimensions: number): { permutation: number[]; signs: number[] } {
  const permutation = Array.from({ length: dimensions }, (_, index) => index);
  const bytes = deterministicBytes(key, `perm:${dimensions}`, Math.max(4, dimensions * 4));
  let cursor = 0;
  for (let index = dimensions - 1; index > 0; index -= 1) {
    if (cursor + 4 > bytes.length) cursor = 0;
    const swapIndex = bytes.readUInt32BE(cursor) % (index + 1);
    cursor += 4;
    const current = permutation[index] ?? index;
    permutation[index] = permutation[swapIndex] ?? swapIndex;
    permutation[swapIndex] = current;
  }
  const signBytes = deterministicBytes(key, `sign:${dimensions}`, dimensions);
  const signs = Array.from({ length: dimensions }, (_, index) => ((signBytes[index] ?? 0) & 1 ? -1 : 1));
  return { permutation, signs };
}

function deterministicBytes(key: Buffer, label: string, length: number): Buffer {
  const chunks: Buffer[] = [];
  let total = 0;
  for (let counter = 0; total < length; counter += 1) {
    const chunk = createHmac("sha256", key).update(label).update(":").update(String(counter)).digest();
    chunks.push(chunk);
    total += chunk.length;
  }
  return Buffer.concat(chunks, total).subarray(0, length);
}

function mapPerson(row: PersonRow | CandidateRow): PersonRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    userId: row.user_id,
    name: row.name,
    relation: row.relation ?? undefined,
    isOwner: row.is_owner,
    voiceProfileId: row.voice_profile_id ?? undefined,
    createdAt: toMillis(row.created_at),
    updatedAt: toMillis(row.updated_at),
  };
}

function centroidAad(scope: SpeakerIdentityScope, profileId: string): string {
  return JSON.stringify(["aipany", 1, scope.tenantId, scope.userId, "profile", profileId, "centroid"]);
}

function sampleAad(scope: SpeakerIdentityScope, profileId: string, sampleId: string): string {
  return JSON.stringify(["aipany", 1, scope.tenantId, scope.userId, "profile", profileId, "sample", sampleId]);
}

function searchProjectionContext(scope: SpeakerIdentityScope): string {
  return JSON.stringify(["aipany-search", 1, scope.tenantId, scope.userId]);
}

function formatPgVector(embedding: number[]): string {
  return `[${embedding.map((value) => Number(value.toFixed(10))).join(",")}]`;
}

function toMillis(value: Date | string | number): number {
  return typeof value === "number" ? value : new Date(value).getTime();
}
