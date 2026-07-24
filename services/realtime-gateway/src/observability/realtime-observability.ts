import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, readdir, readFile, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { GitHubObservabilitySync } from "./github-observability-sync.js";
import { OperationsControlStore } from "../operations/operations-control-store.js";
import { scoreRealtimeSessionQuality, type SessionQualitySummary } from "./session-quality.js";

export type RealtimeEngine = "cascaded" | "omni_realtime";
export type ObservabilityLevel = "debug" | "info" | "warn" | "error";

export interface ObservabilityEvent {
  id: string;
  timestamp: number;
  level: ObservabilityLevel;
  category: string;
  event: string;
  sessionId?: string;
  connectionId?: string;
  engine?: RealtimeEngine;
  tenantHash?: string;
  userHash?: string;
  deviceHash?: string;
  deviceType?: string;
  platform?: string;
  appVersion?: string;
  data?: Record<string, unknown>;
}

export interface TurnLatencySample {
  speechEndToTranscriptFinalMs?: number;
  transcriptFinalToResponseCreatedMs?: number;
  transcriptFinalToFirstTextMs?: number;
  firstTextToFirstAudioMs?: number;
  responseCreatedToFirstAudioMs?: number;
  speechEndToFirstAudioMs?: number;
  gatewayFirstAudioToClientReceiveMs?: number;
  clientReceiveToPlaybackStartMs?: number;
  responseCreatedToPlaybackStartMs?: number;
  speechEndToPlaybackStartMs?: number;
}

export interface SessionReport {
  sessionId: string;
  connectionId: string;
  engine: RealtimeEngine;
  startedAt: number;
  endedAt?: number;
  durationMs?: number;
  tenantHash?: string;
  userHash?: string;
  deviceHash?: string;
  deviceType?: string;
  platform?: string;
  appVersion?: string;
  remoteAddress?: string;
  userAgent?: string;
  closeCode?: number;
  closeReason?: string;
  abnormalDisconnect?: boolean;
  reconnectLikely?: boolean;
  interruptions: number;
  errors: number;
  turns: number;
  latency: TurnLatencySample[];
  quality?: SessionQualitySummary;
}

interface LatencyClock {
  speechStoppedAt?: number;
  transcriptFinalAt?: number;
  responseCreatedAt?: number;
  firstTextAt?: number;
  firstAudioAt?: number;
}

interface SessionClock {
  currentLatency?: LatencyClock;
  lastLatency?: TurnLatencySample;
  lastFirstAudioAt?: number;
  lastFirstAudioReceivedAt?: number;
  lastSpeechStoppedAt?: number;
  lastResponseCreatedAt?: number;
}

interface BeginSessionInput {
  sessionId: string;
  connectionId: string;
  engine: RealtimeEngine;
  tenantId?: string;
  userId?: string;
  deviceId?: string;
  deviceType?: string;
  platform?: string;
  appVersion?: string;
  remoteAddress?: string;
  userAgent?: string;
}

export class SessionObservability {
  private ended = false;
  private readonly clock: SessionClock = {};

  constructor(
    private readonly store: RealtimeObservabilityStore,
    readonly report: SessionReport,
  ) {}

  event(
    event: string,
    data: Record<string, unknown> = {},
    level: ObservabilityLevel = "info",
    category = "realtime",
  ): void {
    if (level === "error") this.report.errors += 1;
    if (event === "response.interrupted" || event === "client.barge_in_detected") this.report.interruptions += 1;
    if (event === "transcript.final") this.report.turns += 1;
    this.updateLatency(event);
    this.store.record({
      level,
      category,
      event,
      sessionId: this.report.sessionId,
      connectionId: this.report.connectionId,
      engine: this.report.engine,
      tenantHash: this.report.tenantHash,
      userHash: this.report.userHash,
      deviceHash: this.report.deviceHash,
      deviceType: this.report.deviceType,
      platform: this.report.platform,
      appVersion: this.report.appVersion,
      data,
    });
  }

  end(closeCode?: number, closeReason?: string): void {
    if (this.ended) return;
    this.ended = true;
    const now = Date.now();
    this.report.endedAt = now;
    this.report.durationMs = now - this.report.startedAt;
    this.report.closeCode = closeCode;
    this.report.closeReason = closeReason;
    this.report.abnormalDisconnect = closeCode !== undefined && closeCode !== 1000;
    this.report.reconnectLikely = Boolean(
      this.report.abnormalDisconnect
      || closeCode === 1001
      || /network|timeout|upstream|reconnect|reset|closed/i.test(closeReason ?? ""),
    );
    this.flushLatency();
    this.report.quality = scoreRealtimeSessionQuality(this.report);
    this.store.record({
      level: "info",
      category: "quality",
      event: "session.quality_summary",
      sessionId: this.report.sessionId,
      connectionId: this.report.connectionId,
      engine: this.report.engine,
      deviceType: this.report.deviceType,
      platform: this.report.platform,
      appVersion: this.report.appVersion,
      data: { ...this.report.quality },
    });
    this.store.finishSession(this.report.sessionId);
    this.store.record({
      level: this.report.abnormalDisconnect ? "warn" : "info",
      category: "session",
      event: "session.ended",
      sessionId: this.report.sessionId,
      connectionId: this.report.connectionId,
      engine: this.report.engine,
      deviceType: this.report.deviceType,
      platform: this.report.platform,
      appVersion: this.report.appVersion,
      data: {
        durationMs: this.report.durationMs,
        closeCode,
        closeReason,
        abnormalDisconnect: this.report.abnormalDisconnect,
        reconnectLikely: this.report.reconnectLikely,
        turns: this.report.turns,
        interruptions: this.report.interruptions,
        errors: this.report.errors,
        qualityScore: this.report.quality.score,
        qualityGrade: this.report.quality.grade,
      },
    });
  }

  private updateLatency(event: string): void {
    const now = Date.now();
    switch (event) {
      case "speech.stopped":
        this.flushLatency();
        this.clock.currentLatency = { speechStoppedAt: now };
        this.clock.lastLatency = undefined;
        this.clock.lastFirstAudioAt = undefined;
        this.clock.lastFirstAudioReceivedAt = undefined;
        this.clock.lastSpeechStoppedAt = now;
        this.clock.lastResponseCreatedAt = undefined;
        break;
      case "transcript.final":
        this.clock.currentLatency ??= {};
        this.clock.currentLatency.transcriptFinalAt = now;
        break;
      case "response.created":
        this.clock.currentLatency ??= {};
        this.clock.currentLatency.responseCreatedAt = now;
        this.clock.lastResponseCreatedAt = now;
        break;
      case "response.first_text":
        this.clock.currentLatency ??= {};
        this.clock.currentLatency.firstTextAt ??= now;
        break;
      case "response.first_audio":
        this.clock.currentLatency ??= {};
        this.clock.currentLatency.firstAudioAt ??= now;
        this.flushLatency();
        break;
      case "client.first_audio_received":
        this.clock.lastFirstAudioReceivedAt = now;
        if (this.clock.lastLatency && this.clock.lastFirstAudioAt !== undefined) {
          this.clock.lastLatency.gatewayFirstAudioToClientReceiveMs = Math.max(0, now - this.clock.lastFirstAudioAt);
        }
        break;
      case "client.playback_started":
      case "client.first_audio_rendered":
        if (this.clock.lastLatency) {
          if (this.clock.lastFirstAudioReceivedAt !== undefined) {
            this.clock.lastLatency.clientReceiveToPlaybackStartMs = Math.max(0, now - this.clock.lastFirstAudioReceivedAt);
          }
          if (this.clock.lastSpeechStoppedAt !== undefined) {
            this.clock.lastLatency.speechEndToPlaybackStartMs = Math.max(0, now - this.clock.lastSpeechStoppedAt);
          }
          if (this.clock.lastResponseCreatedAt !== undefined) {
            this.clock.lastLatency.responseCreatedToPlaybackStartMs = Math.max(0, now - this.clock.lastResponseCreatedAt);
          }
        }
        break;
      default:
        break;
    }
  }

  private flushLatency(): void {
    const item = this.clock.currentLatency;
    if (!item) return;
    if (!item.firstAudioAt && !item.transcriptFinalAt && !item.responseCreatedAt) return;
    const sample: TurnLatencySample = {
      speechEndToTranscriptFinalMs: diff(item.speechStoppedAt, item.transcriptFinalAt),
      transcriptFinalToResponseCreatedMs: diff(item.transcriptFinalAt, item.responseCreatedAt),
      transcriptFinalToFirstTextMs: diff(item.transcriptFinalAt, item.firstTextAt),
      firstTextToFirstAudioMs: diff(item.firstTextAt, item.firstAudioAt),
      responseCreatedToFirstAudioMs: diff(item.responseCreatedAt, item.firstAudioAt),
      speechEndToFirstAudioMs: diff(item.speechStoppedAt, item.firstAudioAt),
    };
    this.report.latency.push(sample);
    if (this.report.latency.length > 200) this.report.latency.shift();
    this.clock.lastLatency = sample;
    this.clock.lastFirstAudioAt = item.firstAudioAt;
    this.clock.lastSpeechStoppedAt = item.speechStoppedAt ?? this.clock.lastSpeechStoppedAt;
    this.clock.lastResponseCreatedAt = item.responseCreatedAt ?? this.clock.lastResponseCreatedAt;
    this.clock.currentLatency = undefined;
  }
}

export class RealtimeObservabilityStore {
  readonly filePath: string;
  private readonly maxEvents: number;
  private readonly maxSessions: number;
  private readonly maxFileBytes: number;
  private readonly events: ObservabilityEvent[] = [];
  private readonly sessions = new Map<string, SessionReport>();
  private readonly activeSessions = new Set<string>();
  private readonly lastDeviceSession = new Map<string, number>();
  private readonly startedAt = Date.now();
  private readonly githubSync: GitHubObservabilitySync;
  private approximateBytes = 0;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(options: { filePath?: string; maxEvents?: number; maxSessions?: number; maxFileBytes?: number } = {}) {
    this.filePath = options.filePath?.trim() || process.env.AIPANY_OBSERVABILITY_FILE?.trim() || "/data/observability/events.jsonl";
    this.maxEvents = options.maxEvents ?? 10_000;
    this.maxSessions = options.maxSessions ?? 2_000;
    this.maxFileBytes = options.maxFileBytes ?? 50 * 1024 * 1024;
    this.githubSync = new GitHubObservabilitySync({
      loadConfig: async () => {
        const operations = new OperationsControlStore({ filePath: process.env.AIPANY_OPERATIONS_CONTROL_PATH });
        await operations.load();
        return operations.getGitHubObservabilityConfig();
      },
    });
  }

  async load(): Promise<void> {
    try {
      const content = await readFile(this.filePath, "utf8");
      const lines = content.split("\n").filter(Boolean).slice(-this.maxEvents);
      for (const line of lines) {
        try {
          const parsed = JSON.parse(line) as ObservabilityEvent;
          if (parsed && parsed.id && parsed.event) this.events.push(parsed);
        } catch {
          // Ignore malformed historical lines and keep serving the operator UI.
        }
      }
      this.approximateBytes = Buffer.byteLength(content);
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "ENOENT")) throw error;
    }
  }

  beginSession(input: BeginSessionInput): SessionObservability {
    const now = Date.now();
    const report: SessionReport = {
      sessionId: input.sessionId,
      connectionId: input.connectionId,
      engine: input.engine,
      startedAt: now,
      tenantHash: input.tenantId ? hashIdentifier(input.tenantId) : undefined,
      userHash: input.userId ? hashIdentifier(input.userId) : undefined,
      deviceHash: input.deviceId ? hashIdentifier(input.deviceId) : undefined,
      deviceType: input.deviceType,
      platform: input.platform,
      appVersion: input.appVersion,
      remoteAddress: input.remoteAddress,
      userAgent: input.userAgent,
      interruptions: 0,
      errors: 0,
      turns: 0,
      latency: [],
    };
    if (report.deviceHash) {
      const previous = this.lastDeviceSession.get(report.deviceHash);
      report.reconnectLikely = previous !== undefined && now - previous < 90_000;
      this.lastDeviceSession.set(report.deviceHash, now);
    }
    this.sessions.set(report.sessionId, report);
    this.activeSessions.add(report.sessionId);
    this.trimSessions();
    this.record({
      level: "info",
      category: "session",
      event: "session.started",
      sessionId: report.sessionId,
      connectionId: report.connectionId,
      engine: report.engine,
      tenantHash: report.tenantHash,
      userHash: report.userHash,
      deviceHash: report.deviceHash,
      deviceType: report.deviceType,
      platform: report.platform,
      appVersion: report.appVersion,
      data: {
        reconnectLikely: report.reconnectLikely,
        remoteAddress: report.remoteAddress,
        userAgent: report.userAgent,
      },
    });
    return new SessionObservability(this, report);
  }

  finishSession(sessionId: string): void {
    this.activeSessions.delete(sessionId);
  }

  record(input: Omit<ObservabilityEvent, "id" | "timestamp"> & { timestamp?: number }): void {
    const event: ObservabilityEvent = {
      id: randomUUID(),
      timestamp: input.timestamp ?? Date.now(),
      level: input.level,
      category: input.category,
      event: input.event,
      sessionId: input.sessionId,
      connectionId: input.connectionId,
      engine: input.engine,
      tenantHash: input.tenantHash,
      userHash: input.userHash,
      deviceHash: input.deviceHash,
      deviceType: input.deviceType,
      platform: input.platform,
      appVersion: input.appVersion,
      data: input.data,
    };
    this.events.push(event);
    if (this.events.length > this.maxEvents) this.events.splice(0, this.events.length - this.maxEvents);
    this.githubSync.record(event);
    const line = `${JSON.stringify(event)}\n`;
    this.approximateBytes += Buffer.byteLength(line);
    this.writeChain = this.writeChain.then(async () => {
      await mkdir(dirname(this.filePath), { recursive: true });
      if (this.approximateBytes >= this.maxFileBytes) await this.rotate();
      await appendFile(this.filePath, line, { encoding: "utf8", mode: 0o600 });
    }).catch((error) => console.error("[aipany] failed to write observability event", error));
  }

  async flush(): Promise<void> {
    await this.writeChain;
  }

  getOverview(windowMs = 60 * 60 * 1000) {
    const now = Date.now();
    const since = now - windowMs;
    const recentSessions = [...this.sessions.values()].filter((session) => session.startedAt >= since);
    const completed = recentSessions.filter((session) => session.endedAt !== undefined);
    const latency = recentSessions.flatMap((session) => session.latency);
    const firstAudio = latency.map((item) => item.speechEndToFirstAudioMs).filter(isFiniteNumber);
    const playbackStart = latency.map((item) => item.speechEndToPlaybackStartMs).filter(isFiniteNumber);
    const transcript = latency.map((item) => item.speechEndToTranscriptFinalMs).filter(isFiniteNumber);
    const firstText = latency.map((item) => item.transcriptFinalToFirstTextMs).filter(isFiniteNumber);
    const tts = latency.map((item) => item.firstTextToFirstAudioMs).filter(isFiniteNumber);
    const qualityScores = completed.map((session) => session.quality?.score).filter(isFiniteNumber);
    const recentEvents = this.events.filter((event) => event.timestamp >= since);
    return {
      generatedAt: now,
      processUptimeMs: now - this.startedAt,
      activeSessions: this.activeSessions.size,
      sessions: recentSessions.length,
      completedSessions: completed.length,
      abnormalDisconnects: completed.filter((session) => session.abnormalDisconnect).length,
      reconnects: recentSessions.filter((session) => session.reconnectLikely).length,
      errors: recentEvents.filter((event) => event.level === "error").length,
      interruptions: recentSessions.reduce((sum, session) => sum + session.interruptions, 0),
      turns: recentSessions.reduce((sum, session) => sum + session.turns, 0),
      engines: countBy(recentSessions.map((session) => session.engine)),
      latency: {
        speechEndToFirstAudio: summarize(firstAudio),
        speechEndToPlaybackStart: summarize(playbackStart),
        speechEndToTranscriptFinal: summarize(transcript),
        transcriptFinalToFirstText: summarize(firstText),
        firstTextToFirstAudio: summarize(tts),
      },
      quality: summarizeScore(qualityScores),
      process: {
        rssBytes: process.memoryUsage().rss,
        heapUsedBytes: process.memoryUsage().heapUsed,
        heapTotalBytes: process.memoryUsage().heapTotal,
        externalBytes: process.memoryUsage().external,
      },
    };
  }

  listSessions(limit = 100): SessionReport[] {
    return [...this.sessions.values()]
      .sort((a, b) => b.startedAt - a.startedAt)
      .slice(0, Math.max(1, Math.min(500, limit)))
      .map((session) => ({
        ...session,
        latency: session.latency.map((item) => ({ ...item })),
        quality: session.quality ? { ...session.quality } : undefined,
      }));
  }

  listEvents(options: { limit?: number; level?: string; category?: string; sessionId?: string; query?: string } = {}): ObservabilityEvent[] {
    const limit = Math.max(1, Math.min(1000, options.limit ?? 200));
    const query = options.query?.trim().toLowerCase();
    return this.events
      .filter((event) => !options.level || event.level === options.level)
      .filter((event) => !options.category || event.category === options.category)
      .filter((event) => !options.sessionId || event.sessionId === options.sessionId)
      .filter((event) => {
        if (!query) return true;
        return `${event.event} ${event.category} ${JSON.stringify(event.data ?? {})}`.toLowerCase().includes(query);
      })
      .slice(-limit)
      .reverse()
      .map((event) => ({ ...event, data: event.data ? { ...event.data } : undefined }));
  }

  private trimSessions(): void {
    if (this.sessions.size <= this.maxSessions) return;
    const remove = [...this.sessions.values()]
      .filter((session) => !this.activeSessions.has(session.sessionId))
      .sort((a, b) => a.startedAt - b.startedAt)
      .slice(0, this.sessions.size - this.maxSessions);
    for (const session of remove) this.sessions.delete(session.sessionId);
  }

  private async rotate(): Promise<void> {
    try {
      const rotatedName = `events-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`;
      await rename(this.filePath, join(dirname(this.filePath), rotatedName));
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "ENOENT")) throw error;
    }
    this.approximateBytes = 0;
    const files = (await readdir(dirname(this.filePath)))
      .filter((name) => /^events-.*\.jsonl$/.test(name))
      .sort()
      .reverse();
    for (const old of files.slice(5)) {
      await unlink(join(dirname(this.filePath), old)).catch(() => undefined);
    }
  }
}

export function hashIdentifier(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function summarize(values: number[]) {
  if (!values.length) return { count: 0, averageMs: undefined, p50Ms: undefined, p95Ms: undefined, maxMs: undefined };
  const sorted = [...values].sort((a, b) => a - b);
  const average = sorted.reduce((sum, value) => sum + value, 0) / sorted.length;
  return {
    count: sorted.length,
    averageMs: Math.round(average),
    p50Ms: percentile(sorted, 0.5),
    p95Ms: percentile(sorted, 0.95),
    maxMs: sorted.at(-1),
  };
}

function summarizeScore(values: number[]) {
  if (!values.length) return { count: 0, averageScore: undefined, p50Score: undefined, p10Score: undefined };
  const sorted = [...values].sort((a, b) => a - b);
  return {
    count: sorted.length,
    averageScore: Math.round(sorted.reduce((sum, value) => sum + value, 0) / sorted.length),
    p50Score: percentile(sorted, 0.5),
    p10Score: percentile(sorted, 0.1),
  };
}

function percentile(sorted: number[], ratio: number): number | undefined {
  if (!sorted.length) return undefined;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1))];
}

function countBy(values: string[]): Record<string, number> {
  const output: Record<string, number> = {};
  for (const value of values) output[value] = (output[value] ?? 0) + 1;
  return output;
}

function diff(start: number | undefined, end: number | undefined): number | undefined {
  if (start === undefined || end === undefined || end < start) return undefined;
  return end - start;
}

function isFiniteNumber(value: number | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
