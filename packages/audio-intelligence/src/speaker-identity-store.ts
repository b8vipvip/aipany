import { randomUUID } from "node:crypto";
import type {
  PersonRecord,
  SpeakerIdentityScope,
  SpeakerMatch,
  SpeakerProximity,
  VoiceProfile,
  VoiceSample,
} from "./types.js";

export interface SpeakerIdentityStoreOptions {
  confirmSampleCount?: number;
  confirmConfidence?: number;
  matchThreshold?: number;
  minimumSampleQuality?: number;
}

export interface AddVoiceSampleInput {
  personId: string;
  embedding: number[];
  sourceSessionId?: string;
  environment?: string;
  proximity?: SpeakerProximity;
  quality?: number;
}

export type MaybePromise<T> = T | Promise<T>;

export interface SpeakerIdentityStore {
  createPerson(
    scope: SpeakerIdentityScope,
    input: { name: string; relation?: string; isOwner?: boolean },
  ): MaybePromise<PersonRecord>;
  getPerson(scope: SpeakerIdentityScope, personId: string): MaybePromise<PersonRecord | undefined>;
  listPeople(scope: SpeakerIdentityScope): MaybePromise<PersonRecord[]>;
  getProfileByPerson(scope: SpeakerIdentityScope, personId: string): MaybePromise<VoiceProfile | undefined>;
  addVoiceSample(scope: SpeakerIdentityScope, input: AddVoiceSampleInput): MaybePromise<VoiceProfile>;
  identify(scope: SpeakerIdentityScope, embedding: number[]): MaybePromise<SpeakerMatch>;
  deletePerson(scope: SpeakerIdentityScope, personId: string): MaybePromise<boolean>;
  close?(): MaybePromise<void>;
}

export type ResolvedSpeakerIdentityStoreOptions = Required<SpeakerIdentityStoreOptions>;

export function resolveSpeakerIdentityStoreOptions(
  options: SpeakerIdentityStoreOptions = {},
): ResolvedSpeakerIdentityStoreOptions {
  return {
    confirmSampleCount: options.confirmSampleCount ?? 4,
    confirmConfidence: options.confirmConfidence ?? 0.86,
    matchThreshold: options.matchThreshold ?? 0.82,
    minimumSampleQuality: options.minimumSampleQuality ?? 0.55,
  };
}

/**
 * 内存实现保留给本地开发、单元测试以及数据库未启用时使用。
 * 数据按 tenantId + userId 作用域隔离，行为与 PostgreSQL Store 保持一致。
 */
export class InMemorySpeakerIdentityStore implements SpeakerIdentityStore {
  private readonly people = new Map<string, PersonRecord>();
  private readonly profiles = new Map<string, VoiceProfile>();
  private readonly options: ResolvedSpeakerIdentityStoreOptions;

  constructor(options: SpeakerIdentityStoreOptions = {}) {
    this.options = resolveSpeakerIdentityStoreOptions(options);
  }

  createPerson(
    scope: SpeakerIdentityScope,
    input: { name: string; relation?: string; isOwner?: boolean },
  ): PersonRecord {
    validateScope(scope);
    const now = Date.now();
    const person: PersonRecord = {
      id: randomUUID(),
      tenantId: scope.tenantId,
      userId: scope.userId,
      name: input.name.trim(),
      relation: input.relation?.trim() || undefined,
      isOwner: input.isOwner ?? false,
      createdAt: now,
      updatedAt: now,
    };
    if (!person.name) throw new Error("人物名称不能为空");
    this.people.set(person.id, person);
    return structuredClone(person);
  }

  getPerson(scope: SpeakerIdentityScope, personId: string): PersonRecord | undefined {
    const person = this.people.get(personId);
    return person && belongsToScope(person, scope) ? structuredClone(person) : undefined;
  }

  listPeople(scope: SpeakerIdentityScope): PersonRecord[] {
    return [...this.people.values()]
      .filter((person) => belongsToScope(person, scope))
      .map((person) => structuredClone(person));
  }

  getProfileByPerson(scope: SpeakerIdentityScope, personId: string): VoiceProfile | undefined {
    const person = this.people.get(personId);
    if (!person || !belongsToScope(person, scope) || !person.voiceProfileId) return undefined;
    const profile = this.profiles.get(person.voiceProfileId);
    return profile ? structuredClone(profile) : undefined;
  }

  addVoiceSample(scope: SpeakerIdentityScope, input: AddVoiceSampleInput): VoiceProfile {
    const person = this.people.get(input.personId);
    if (!person || !belongsToScope(person, scope)) throw new Error(`人物不存在或无权访问：${input.personId}`);
    validateEmbedding(input.embedding);

    const quality = clamp(input.quality ?? 1, 0, 1);
    if (quality < this.options.minimumSampleQuality) {
      throw new Error(`声纹样本质量过低：${quality.toFixed(2)}`);
    }

    const now = Date.now();
    let profile = person.voiceProfileId ? this.profiles.get(person.voiceProfileId) : undefined;
    if (!profile) {
      profile = {
        id: randomUUID(),
        personId: person.id,
        status: "learning",
        confidence: 0,
        centroid: [...input.embedding],
        samples: [],
        createdAt: now,
        updatedAt: now,
      };
      person.voiceProfileId = profile.id;
      person.updatedAt = now;
      this.profiles.set(profile.id, profile);
    } else if (profile.centroid.length !== input.embedding.length) {
      throw new Error("声纹向量维度与人物现有 Voice Profile 不一致");
    }

    const sample = createVoiceSample(input, quality, now);
    profile.samples.push(sample);
    applyProfileStatistics(profile, this.options);
    profile.updatedAt = now;

    return structuredClone(profile);
  }

  identify(scope: SpeakerIdentityScope, embedding: number[]): SpeakerMatch {
    validateEmbedding(embedding);

    let best: SpeakerMatch = {
      similarity: 0,
      confident: false,
    };

    for (const profile of this.profiles.values()) {
      const person = this.people.get(profile.personId);
      if (!person || !belongsToScope(person, scope)) continue;
      const candidate = scoreSpeakerProfile(profile, person, embedding, this.options.matchThreshold);
      if (candidate.similarity <= best.similarity) continue;
      best = candidate;
    }

    return structuredClone(best);
  }

  deletePerson(scope: SpeakerIdentityScope, personId: string): boolean {
    const person = this.people.get(personId);
    if (!person || !belongsToScope(person, scope)) return false;
    if (person.voiceProfileId) this.profiles.delete(person.voiceProfileId);
    return this.people.delete(personId);
  }
}

export function createVoiceSample(input: AddVoiceSampleInput, quality: number, createdAt = Date.now()): VoiceSample {
  return {
    id: randomUUID(),
    embedding: [...input.embedding],
    createdAt,
    sourceSessionId: input.sourceSessionId,
    environment: input.environment,
    proximity: input.proximity,
    quality,
  };
}

export function applyProfileStatistics(
  profile: VoiceProfile,
  options: ResolvedSpeakerIdentityStoreOptions,
): VoiceProfile {
  profile.centroid = weightedCentroid(profile.samples);
  profile.confidence = calculateProfileConfidence(profile.samples, profile.centroid);
  profile.status =
    profile.samples.length >= options.confirmSampleCount && profile.confidence >= options.confirmConfidence
      ? "confirmed"
      : "learning";
  return profile;
}

export function scoreSpeakerProfile(
  profile: VoiceProfile,
  person: PersonRecord,
  embedding: number[],
  matchThreshold: number,
): SpeakerMatch {
  if (profile.centroid.length !== embedding.length || profile.samples.length === 0) {
    return { similarity: 0, confident: false };
  }

  const similarities = profile.samples
    .map((sample) => cosineSimilarity(sample.embedding, embedding))
    .sort((a, b) => b - a);
  const top = similarities.slice(0, Math.min(3, similarities.length));
  const sampleScore = top.reduce((sum, value) => sum + value, 0) / top.length;
  const centroidScore = cosineSimilarity(profile.centroid, embedding);
  const similarity = clamp(sampleScore * 0.7 + centroidScore * 0.3, -1, 1);

  return {
    person: structuredClone(person),
    profile: structuredClone(profile),
    similarity,
    confident: profile.status === "confirmed" && similarity >= matchThreshold,
  };
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let index = 0; index < a.length; index += 1) {
    const av = a[index] ?? 0;
    const bv = b[index] ?? 0;
    dot += av * bv;
    normA += av * av;
    normB += bv * bv;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export function weightedCentroid(samples: VoiceSample[]): number[] {
  const dimensions = samples[0]?.embedding.length ?? 0;
  const output = new Array<number>(dimensions).fill(0);
  let totalWeight = 0;

  for (const sample of samples) {
    if (sample.embedding.length !== dimensions) throw new Error("Voice Profile 中存在不同维度的声纹样本");
    totalWeight += sample.quality;
    for (let index = 0; index < dimensions; index += 1) {
      output[index] = (output[index] ?? 0) + (sample.embedding[index] ?? 0) * sample.quality;
    }
  }

  if (totalWeight === 0) return output;
  return output.map((value) => value / totalWeight);
}

export function calculateProfileConfidence(samples: VoiceSample[], centroid: number[]): number {
  if (samples.length === 0) return 0;
  if (samples.length === 1) return clamp(samples[0]?.quality ?? 0, 0, 1) * 0.65;

  const consistency =
    samples.reduce((sum, sample) => sum + Math.max(0, cosineSimilarity(sample.embedding, centroid)), 0) / samples.length;
  const quality = samples.reduce((sum, sample) => sum + sample.quality, 0) / samples.length;
  const evidence = Math.min(1, samples.length / 6);
  return clamp(consistency * 0.55 + quality * 0.25 + evidence * 0.2, 0, 1);
}

export function validateEmbedding(embedding: number[]): void {
  if (embedding.length < 2 || embedding.some((value) => !Number.isFinite(value))) {
    throw new Error("无效的声纹向量");
  }
}

export function validateScope(scope: SpeakerIdentityScope): void {
  if (!scope.tenantId.trim() || !scope.userId.trim()) throw new Error("Speaker Identity 作用域不能为空");
}

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function belongsToScope(person: PersonRecord, scope: SpeakerIdentityScope): boolean {
  return person.tenantId === scope.tenantId && person.userId === scope.userId;
}
