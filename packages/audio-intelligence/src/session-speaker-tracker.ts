import { cosineSimilarity } from "./speaker-identity-store.js";

export interface SessionSpeakerTrackerOptions {
  matchThreshold?: number;
  maxSpeakers?: number;
}

export interface SessionSpeakerAssignment {
  sessionSpeakerId: string;
  similarity: number;
  isNew: boolean;
}

interface SessionSpeakerCluster {
  id: string;
  centroid: number[];
  sampleCount: number;
  lastSeenAt: number;
}

/**
 * 在没有实时 diarization 标签时，用每个 VAD 语音轮次的声纹 embedding 做会话内聚类。
 * 这不是多人重叠语音分离；它用于把连续出现的同一未知说话人稳定映射到 Speaker_1/2/3。
 */
export class SessionSpeakerTracker {
  private readonly matchThreshold: number;
  private readonly maxSpeakers: number;
  private readonly clusters: SessionSpeakerCluster[] = [];
  private sequence = 0;

  constructor(options: SessionSpeakerTrackerOptions = {}) {
    this.matchThreshold = options.matchThreshold ?? 0.76;
    this.maxSpeakers = options.maxSpeakers ?? 8;
  }

  observe(embedding: number[], observedAt = Date.now()): SessionSpeakerAssignment {
    if (embedding.length < 2) throw new Error("无效的会话声纹向量");

    let best: SessionSpeakerCluster | undefined;
    let bestSimilarity = -1;
    for (const cluster of this.clusters) {
      if (cluster.centroid.length !== embedding.length) continue;
      const similarity = cosineSimilarity(cluster.centroid, embedding);
      if (similarity > bestSimilarity) {
        best = cluster;
        bestSimilarity = similarity;
      }
    }

    if (best && bestSimilarity >= this.matchThreshold) {
      best.centroid = runningCentroid(best.centroid, best.sampleCount, embedding);
      best.sampleCount += 1;
      best.lastSeenAt = observedAt;
      return {
        sessionSpeakerId: best.id,
        similarity: bestSimilarity,
        isNew: false,
      };
    }

    if (this.clusters.length >= this.maxSpeakers) {
      const fallback = [...this.clusters].sort((a, b) => b.lastSeenAt - a.lastSeenAt)[0];
      if (!fallback) throw new Error("无法创建会话说话人聚类");
      const similarity = fallback.centroid.length === embedding.length
        ? cosineSimilarity(fallback.centroid, embedding)
        : 0;
      return {
        sessionSpeakerId: fallback.id,
        similarity,
        isNew: false,
      };
    }

    this.sequence += 1;
    const id = `speaker_${this.sequence}`;
    this.clusters.push({
      id,
      centroid: [...embedding],
      sampleCount: 1,
      lastSeenAt: observedAt,
    });
    return {
      sessionSpeakerId: id,
      similarity: 1,
      isNew: true,
    };
  }

  getSpeakerCount(): number {
    return this.clusters.length;
  }
}

function runningCentroid(current: number[], sampleCount: number, next: number[]): number[] {
  const total = sampleCount + 1;
  return current.map((value, index) => (value * sampleCount + (next[index] ?? 0)) / total);
}
