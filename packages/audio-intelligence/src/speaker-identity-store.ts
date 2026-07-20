import { randomUUID } from "node:crypto";
import type { PersonRecord, SpeakerMatch, SpeakerProximity, VoiceProfile, VoiceSample } from "./types.js";

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

/**
 * v0.2 先提供内存实现，定义稳定的领域接口和评分逻辑。
 * 后续 PostgreSQL/pgvector 实现只需要保持相同方法语义即可替换。
 */
export class InMemorySpeakerIdentityStore {
  private readonly people = new Map<string, PersonRecord>();
  private readonly profiles = new Map<string, VoiceProfile>();
  private readonly options: Required<SpeakerIdentityStoreOptions>;

  constructor(options: SpeakerIdentityStoreOptions = {}) {
    this.options = {
      confirmSampleCount: options.confirmSampleCount ?? 4,
      confirmConfidence: options.confirmConfidence ?? 0.86,
      matchThreshold: options.matchThreshold ?? 0.82,
      minimumSampleQuality: options.minimumSampleQuality ?? 0.55,
    };
  }

  createPerson(input: { name: string; relation?: string; isOwner?: boolean }): PersonRecord {
    const now = Date.now();
    const person: PersonRecord = {
      id: randomUUID(),
      name: input.name.trim(),
      relation: input.relation?.trim() || undefined,
      isOwner: input.isOwner ?? false,
      createdAt: now,
      updatedAt: now,
    };
    this.people.set(person.id, person);
    return structuredClone(person);
  }

  getPerson(personId: string): PersonRecord | undefined {
    const person = this.people.get(personId);
    return person ? structuredClone(person) : undefined;
  }

  listPeople(): PersonRecord[] {
    return [...this.people.values()].map((person) => structuredClone(person));
  }

  getProfileByPerson(personId: string): VoiceProfile | undefined {
    const person = this.people.get(personId);
    if (!person?.voiceProfileId) return undefined;
    const profile = this.profiles.get(person.voiceProfileId);
    return profile ? structuredClone(profile) : undefined;
  }

  addVoiceSample(input: AddVoiceSampleInput): VoiceProfile {
    const person = this.people.get(input.personId);
    if (!person) throw new Error(`人物不存在：${input.personId}`);
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

    const sample: VoiceSample = {
      id: randomUUID(),
      embedding: [...input.embedding],
      createdAt: now,
      sourceSessionId: input.sourceSessionId,
      environment: input.environment,
      proximity: input.proximity,
      quality,
    };
    profile.samples.push(sample);
    profile.centroid = weightedCentroid(profile.samples);
    profile.confidence = calculateProfileConfidence(profile.samples, profile.centroid);
    profile.status =
      profile.samples.length >= this.options.confirmSampleCount && profile.confidence >= this.options.confirmConfidence
        ? "confirmed"
        : "learning";
    profile.updatedAt = now;

    return structuredClone(profile);
  }

  identify(embedding: number[]): SpeakerMatch {
    validateEmbedding(embedding);

    let best: SpeakerMatch = {
      similarity: 0,
      confident: false,
    };

    for (const profile of this.profiles.values()) {
      if (profile.centroid.length !== embedding.length || profile.samples.length === 0) continue;
      const similarities = profile.samples
        .map((sample) => cosineSimilarity(sample.embedding, embedding))
        .sort((a, b) => b - a);

      const top = similarities.slice(0, Math.min(3, similarities.length));
      const sampleScore = top.reduce((sum, value) => sum + value, 0) / top.length;
      const centroidScore = cosineSimilarity(profile.centroid, embedding);
      const similarity = clamp(sampleScore * 0.7 + centroidScore * 0.3, -1, 1);

      if (similarity <= best.similarity) continue;
      const person = this.people.get(profile.personId);
      best = {
        person: person ? structuredClone(person) : undefined,
        profile: structuredClone(profile),
        similarity,
        confident: profile.status === "confirmed" && similarity >= this.options.matchThreshold,
      };
    }

    return best;
  }
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

function weightedCentroid(samples: VoiceSample[]): number[] {
  const dimensions = samples[0]?.embedding.length ?? 0;
  const output = new Array<number>(dimensions).fill(0);
  let totalWeight = 0;

  for (const sample of samples) {
    totalWeight += sample.quality;
    for (let index = 0; index < dimensions; index += 1) {
      output[index] = (output[index] ?? 0) + (sample.embedding[index] ?? 0) * sample.quality;
    }
  }

  if (totalWeight === 0) return output;
  return output.map((value) => value / totalWeight);
}

function calculateProfileConfidence(samples: VoiceSample[], centroid: number[]): number {
  if (samples.length === 0) return 0;
  if (samples.length === 1) return clamp(samples[0]?.quality ?? 0, 0, 1) * 0.65;

  const consistency =
    samples.reduce((sum, sample) => sum + Math.max(0, cosineSimilarity(sample.embedding, centroid)), 0) / samples.length;
  const quality = samples.reduce((sum, sample) => sum + sample.quality, 0) / samples.length;
  const evidence = Math.min(1, samples.length / 6);
  return clamp(consistency * 0.55 + quality * 0.25 + evidence * 0.2, 0, 1);
}

function validateEmbedding(embedding: number[]): void {
  if (embedding.length < 2 || embedding.some((value) => !Number.isFinite(value))) {
    throw new Error("无效的声纹向量");
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
