import { randomUUID } from "node:crypto";
import type {
  ActiveInteractionMode,
  InteractionMode,
  ModeChangeSource,
  ModeState,
  ModeSuggestion,
  SpeakerObservation,
} from "./types.js";

export interface ModeManagerOptions {
  initialMode?: InteractionMode;
  initialActiveMode?: ActiveInteractionMode;
  stableSpeakerWindowMs?: number;
  minimumSpeechMs?: number;
  minimumSpeakerConfidence?: number;
  multiSpeakerThreshold?: number;
  suggestionCooldownMs?: number;
  returnToSingleSpeakerMs?: number;
  suggestWhenModePinned?: boolean;
}

interface SpeakerActivity {
  firstSeenAt: number;
  lastSeenAt: number;
  speechMs: number;
  confidence: number;
}

export class ModeManager {
  private readonly options: Required<ModeManagerOptions>;
  private readonly speakers = new Map<string, SpeakerActivity>();
  private state: ModeState;
  private lastSuggestionAt = 0;
  private singleSpeakerSince?: number;

  constructor(options: ModeManagerOptions = {}) {
    this.options = {
      initialMode: options.initialMode ?? "auto",
      initialActiveMode: options.initialActiveMode ?? "owner_focus",
      stableSpeakerWindowMs: options.stableSpeakerWindowMs ?? 30_000,
      minimumSpeechMs: options.minimumSpeechMs ?? 2_500,
      minimumSpeakerConfidence: options.minimumSpeakerConfidence ?? 0.65,
      multiSpeakerThreshold: options.multiSpeakerThreshold ?? 2,
      suggestionCooldownMs: options.suggestionCooldownMs ?? 10 * 60_000,
      returnToSingleSpeakerMs: options.returnToSingleSpeakerMs ?? 45_000,
      suggestWhenModePinned: options.suggestWhenModePinned ?? true,
    };

    const activeMode = this.options.initialMode === "group" ? "group" : this.options.initialActiveMode;
    this.state = {
      configuredMode: this.options.initialMode,
      activeMode,
      changedAt: Date.now(),
      source: "manual",
    };
  }

  getState(): ModeState {
    return structuredClone(this.state);
  }

  setMode(mode: InteractionMode, source: ModeChangeSource): ModeState {
    const activeMode = mode === "auto" ? this.state.activeMode : mode;
    this.state = {
      configuredMode: mode,
      activeMode,
      changedAt: Date.now(),
      source,
    };
    return this.getState();
  }

  acceptSuggestion(suggestionId: string): ModeState | undefined {
    const suggestion = this.state.pendingSuggestion;
    if (!suggestion || suggestion.id !== suggestionId) return undefined;
    this.state = {
      configuredMode: this.state.configuredMode,
      activeMode: suggestion.to,
      changedAt: Date.now(),
      source: "suggestion_accepted",
    };
    return this.getState();
  }

  dismissSuggestion(suggestionId: string): ModeState {
    if (this.state.pendingSuggestion?.id === suggestionId) {
      this.state = { ...this.state, pendingSuggestion: undefined };
    }
    return this.getState();
  }

  observeSpeaker(observation: SpeakerObservation): ModeSuggestion | undefined {
    const now = observation.observedAt;
    this.pruneOldSpeakers(now);

    if (observation.confidence >= this.options.minimumSpeakerConfidence) {
      const current = this.speakers.get(observation.sessionSpeakerId);
      this.speakers.set(observation.sessionSpeakerId, {
        firstSeenAt: current?.firstSeenAt ?? now,
        lastSeenAt: now,
        speechMs: (current?.speechMs ?? 0) + observation.speechDurationMs,
        confidence: Math.max(current?.confidence ?? 0, observation.confidence),
      });
    }

    const stableSpeakerCount = this.getStableSpeakerCount();
    if (stableSpeakerCount >= this.options.multiSpeakerThreshold) {
      this.singleSpeakerSince = undefined;
      if (this.state.activeMode === "owner_focus") {
        return this.maybeCreateSuggestion("group", "multiple_stable_speakers", stableSpeakerCount, now);
      }
      return undefined;
    }

    if (stableSpeakerCount <= 1) {
      this.singleSpeakerSince ??= now;
      if (
        this.state.activeMode === "group" &&
        now - this.singleSpeakerSince >= this.options.returnToSingleSpeakerMs
      ) {
        return this.maybeCreateSuggestion("owner_focus", "returned_to_single_speaker", stableSpeakerCount, now);
      }
    }

    return undefined;
  }

  detectVoiceCommand(text: string): InteractionMode | undefined {
    const normalized = text.replace(/[，。！？、,.!?\s]/gu, "");
    if (/自动模式|自动判断|你自己判断|自动切换/.test(normalized)) return "auto";
    if (/大家一起聊|多人模式|一起聊天|听大家说|加入我们|所有人一起/.test(normalized)) return "group";
    if (/只听我|专注模式|别听他们|只跟我聊|只和我聊|只听主人/.test(normalized)) return "owner_focus";
    return undefined;
  }

  private maybeCreateSuggestion(
    target: ActiveInteractionMode,
    reason: ModeSuggestion["reason"],
    speakerCount: number,
    now: number,
  ): ModeSuggestion | undefined {
    if (this.state.pendingSuggestion) return undefined;
    if (this.state.configuredMode !== "auto" && !this.options.suggestWhenModePinned) return undefined;
    if (now - this.lastSuggestionAt < this.options.suggestionCooldownMs) return undefined;

    const suggestion: ModeSuggestion = {
      id: randomUUID(),
      from: this.state.activeMode,
      to: target,
      reason,
      speakerCount,
      createdAt: now,
    };
    this.lastSuggestionAt = now;
    this.state = { ...this.state, pendingSuggestion: suggestion };
    return structuredClone(suggestion);
  }

  private getStableSpeakerCount(): number {
    let count = 0;
    for (const activity of this.speakers.values()) {
      if (
        activity.speechMs >= this.options.minimumSpeechMs &&
        activity.confidence >= this.options.minimumSpeakerConfidence
      ) {
        count += 1;
      }
    }
    return count;
  }

  private pruneOldSpeakers(now: number): void {
    for (const [speakerId, activity] of this.speakers.entries()) {
      if (now - activity.lastSeenAt > this.options.stableSpeakerWindowMs) {
        this.speakers.delete(speakerId);
      }
    }
  }
}
