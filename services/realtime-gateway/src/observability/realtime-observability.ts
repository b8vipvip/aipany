import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, readdir, rename, stat, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { GitHubObservabilitySync } from "./github-observability-sync.js";

export type RealtimeEngine = "cascaded" | "omni_realtime";
export type ObservabilityLevel = "info" | "warn" | "error";

export interface ObservabilityEvent {
  id: string;
  timestamp: number;
  level: ObservabilityLevel;
  category: string;
  event: string;
  sessionId?: string;
  connectionId?: string;
  engine?: RealtimeEngine;
  tenantId?: string;
  userId?: string;
  deviceIdHash?: string;
  data?: Record<string, unknown>;
}

export interface TurnLatencySample {
  speechEndToTranscriptFinalMs?: number;
  transcriptFinalToFirstTextMs?: number;
  firstTextToFirstAudioMs?: number;
  speechEndToFirstAudioMs?: number;
  responseCreatedToFirstAudioMs?: number;
}

export interface SessionReport {
  sessionId: string;
  connectionId: string;
  engine: RealtimeEngine;
  tenantId?: string;
  userId?: string;
  deviceIdHash?: string;
  deviceType?: string;
  platform?: string;
  appVersion?: string;
  startedAt: number;
  endedAt?: number;
  durationMs?: number;
  closeCode?: number;
  closeReason?: string;
  abnormalDisconnect: boolean;
  reconnectLikely: boolean;
  turns: number;
  interruptions: number;
  errors: number;
  lastActivityAt: number;
  lastEvent: string;
  latency: TurnLatencySample[];
}

interface SessionClock {
  speechEndedAt?: number;
  transcriptFinalAt?: number;
  firstTextAt?: number;
  responseCreatedAt?: number;
  firstAudioAt?: number;
  currentLatency?: TurnLatencySample;
}

export interface SessionObservabilityMeta {
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
    const now = Date.now();
    this.report.lastActivityAt = now;
    this.report.lastEvent = event;

    if (event === "speech.stopped") {
      this.clock.speechEndedAt = now;
      this.clock.currentLatency = {};
    } else if (event === "transcript.final") {
      this.clock.transcriptFinalAt = now;
      this.report.turns += 1;
      if (this.clock.speechEndedAt) {
        this.currentLatency().speechEndToTranscriptFinalMs = now - this.clock.speechEndedAt;
      }
    } else if (event === "response.created") {
      this.clock.responseCreatedAt = now;
      this.clock.firstTextAt = undefined;
      this.clock.firstAudioAt = undefined;
    } else if (event === "response.first_text" && !this.clock.firstTextAt) {
      this.clock.firstTextAt = now;
      if (this.clock.transcriptFinalAt) {
        this.currentLatency().transcriptFinalToFirstTextMs = now - this.clock.transcriptFinalAt;
      }
    } else if (event === "response.first_audio" && !this.clock.firstAudioAt) {
      this.clock.firstAudioAt = now;
      if (this.clock.firstTextAt) {
        this.currentLatency().firstTextToFirstAudioMs = now - this.clock.firstTextAt;
      }
      if (this.clock.speechEndedAt) {
        this.currentLatency().speechEndToFirstAudioMs = now - this.clock.speechEndedAt;
      }
      if (this.clock.responseCreatedAt) {
        this.currentLatency().responseCreatedToFirstAudioMs = now - this.clock.responseCreatedAt;
      }
      this.flushLatency();
    } else if (event === "response.interrupted") {
      this.report.interruptions += 1;
    } else if (level === "error" || event.endsWith(".error")) {
      this.report.errors += 1;
    }

    this.store.record({
      level,
      category,
      event,
      sessionId: this.report.sessionId,
      connectionId: this.report.connectionId,
      engine: this.report.engine,
      tenantId: this.report.tenantId,
      userId: this.report.userId,
      deviceIdHash: this.report.deviceIdHash,
      data,
    });
  }

  end(code?: number, reason?: string): void {
    if (this.ended) return;
    this.ended = true;
    this.flushLatency();
    const now = Date.now();
    this.report.endedAt = now;
    this.report.durationMs = now - this.report.startedAt;
    this.report.closeCode = code;
    this.report.closeReason = reason;
    this.report.abnormalDisconnect = code !== undefined && code !== 1000 && code !== 1001;
    this.report.lastActivityAt = now;
    this.report.lastEvent = "session.ended";
    this.store.finishSession(this.report);
    this.store.record({
      level: this.report.abnormalDisconnect ? "warn" : "info",
      category: "connection",
      event: "session.ended",
      sessionId: this.report.sessionId,
      connectionId: this.report.connectionId,
      engine: this.report.engine,
      tenantId: this.report.tenantId,
      userId: this.report.userId,
      deviceIdHash: this.report.deviceIdHash,
      data: {
        code,
        reason: reason || "",
        durationMs: this.report.durationMs,
        turns: this.report.turns,
        interruptions: this.report.interruptions,
        errors: this.report.errors,
        abnormalDisconnect: this.report.abnormalDisconnect,
      },
    });
  }

  private currentLatency(): TurnLatencySample {
    this.clock.currentLatency ??= {};
    return this.clock.currentLatency;
  }

  private flushLatency(): void {
    const sample = this.clock.currentLatency;
    if (!sample || Object.keys(sample).length === 0) return;
    this.report.latency.push({ ...sample });
    if (this.report.latency.length > 50) this.report.latency.splice(0, this.report.latency.length - 50);
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
  private readonly activeSessions = new Map<string, SessionReport>();
  private readonly lastDeviceSession = new Map<string, number>();
  private readonly githubSync: GitHubObservabilitySync;
  private writeQueue: Promise<void> = Promise.resolve();
  private approximateBytes = 0;
  private startedAt = Date.now();

  constructor(options: {
    filePath?: string;
    maxEvents?: number;
    maxSessions?: number;
    maxFileBytes?: number;
    githubSync?: GitHubObservabilitySync;
  } = {}) {
    this.filePath = options.filePath?.trim() || process.env.AIPANY_OBSERVABILITY_PATH?.trim() || "/data/observability/events.jsonl";
    this.maxEvents = options.maxEvents ?? 5000;
    this.maxSessions = options.maxSessions ?? 1000;
    this.maxFileBytes = options.maxFileBytes ?? 20 * 1024 * 1024;
    this.githubSync = options.githubSync ?? new GitHubObservabilitySync();
  }

  async load(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    try {
      const info = await stat(this.filePath);
      this.approximateBytes = info.size;
      const content = await readFile(this.filePath, "utf8");
      const lines = content.split("\n").filter(Boolean).slice(-this.maxEvents);
      for (const line of lines) {
        try {
          const event = JSON.parse(line) as ObservabilityEvent;
          if (event && typeof event.event === "string" && typeof event.timestamp === "number") this.events.push(event);
        } catch {
          // Ignore damaged trailing lines. New records remain append-only and valid.
        }
      }
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "ENOENT")) throw error;
    }
  }

  beginSession(meta: SessionObservabilityMeta): SessionObservability {
    const now = Date.now();
    const deviceIdHash = meta.deviceId ? hashIdentifier(meta.deviceId) : undefined;
    const previousEndedAt = deviceIdHash ? this.lastDeviceSession.get(deviceIdHash) : undefined;
    const report: SessionReport = {
      sessionId: meta.sessionId,
      connectionId: meta.connectionId,
      engine: meta.engine,
      tenantId: meta.tenantId,
      userId: meta.userId,
      deviceIdHash,
      deviceType: meta.deviceType,
      platform: meta.platform,
      appVersion: meta.appVersion,
      startedAt: now,
      abnormalDisconnect: false,
      reconnectLikely: previousEndedAt !== undefined && now - previousEndedAt < 60_000,
      turns: 0,
      interruptions: 0,
      errors: 0,
      lastActivityAt: now,
      lastEvent: "session.started",
      latency: [],
    };
    this.sessions.set(report.sessionId, report);
    this.activeSessions.set(report.sessionId, report);
    this.trimSessions();
    this.record({
      level: "info",
      category: "connection",
      event: "session.started",
      sessionId: report.sessionId,
      connectionId: report.connectionId,
      engine: report.engine,
      tenantId: report.tenantId,
      userId: report.userId,
      deviceIdHash,
      data: {
        deviceType: report.deviceType,
        platform: report.platform,
        appVersion: report.appVersion,
        reconnectLikely: report.reconnectLikely,
        remoteAddress: meta.remoteAddress,
        userAgent: meta.userAgent,
      },
    });
    return new SessionObservability(this, report);
  }

  finishSession(report: SessionReport): void {
    this.activeSessions.delete(report.sessionId);
    this.sessions.set(report.sessionId, report);
    if (report.deviceIdHash && report.endedAt) this.lastDeviceSession.set(report.deviceIdHash, report.endedAt);
    this.trimSessions();
  }

  record(input: Omit<ObservabilityEvent, "id" | "timestamp"> & { timestamp?: number }): void {
    const event: ObservabilityEvent = {
      ...input,
      id: randomUUID(),
      timestamp: input.timestamp ?? Date.now(),
    };
    this.events.push(event);
    this.githubSync.enqueue(event);
    if (this.events.length > this.maxEvents) this.events.splice(0, this.events.length - this.maxEvents);
    const line = `${JSON.stringify(event)}\n`;
    this.approximateBytes += Buffer.byteLength(line);
    this.writeQueue = this.writeQueue
      .then(async () => {
        await mkdir(dirname(this.filePath), { recursive: true });
        if (this.approximateBytes >= this.maxFileBytes) await this.rotate();
        await appendFile(this.filePath, line, { encoding: "utf8", mode: 0o600 });
      })
      .catch(() => undefined);
  }

  overview(windowMs = 24 * 60 * 60 * 1000) {
    const now = Date.now();
    const since = now - windowMs;
    const recentSessions = [...this.sessions.values()].filter((session) => session.startedAt >= since);
    const completed = recentSessions.filter((session) => session.endedAt !== undefined);
    const latency = recentSessions.flatMap((session) => session.latency);
    const firstAudio = latency.map((item) => item.speechEndToFirstAudioMs).filter(isFiniteNumber);
    const transcript = latency.map((item) => item.speechEndToTranscriptFinalMs).filter(isFiniteNumber);
    const firstText = latency.map((item) => item.transcriptFinalToFirstTextMs).filter(isFiniteNumber);
    const tts = latency.map((item) => item.firstTextToFirstAudioMs).filter(isFiniteNumber);
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
        speechEndToTranscriptFinal: summarize(transcript),
        transcriptFinalToFirstText: summarize(firstText),
        firstTextToFirstAudio: summarize(tts),
      },
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
      .map((session) => ({ ...session, latency: session.latency.map((item) => ({ ...item })) }));
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
    for (const old of files.slice(5)) await unlink(join(dirname(this.filePath), old)).catch(() => undefined);
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

function percentile(sorted: number[], ratio: number): number | undefined {
  if (!sorted.length) return undefined;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1))];
}

function countBy(values: string[]): Record<string, number> {
  const output: Record<string, number> = {};
  for (const value of values) output[value] = (output[value] ?? 0) + 1;
  return output;
}

function isFiniteNumber(value: number | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
