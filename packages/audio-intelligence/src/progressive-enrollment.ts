import { randomUUID } from "node:crypto";
import type { EnrollmentState, SpeakerObservation, VoiceProfile } from "./types.js";
import { InMemorySpeakerIdentityStore } from "./speaker-identity-store.js";

export class ProgressiveVoiceEnrollmentManager {
  private readonly sessions = new Map<string, EnrollmentState>();

  constructor(private readonly store: InMemorySpeakerIdentityStore) {}

  begin(input: { sessionId: string; personName: string; relation?: string; isOwner?: boolean }): EnrollmentState {
    const person = this.store.createPerson({
      name: input.personName,
      relation: input.relation,
      isOwner: input.isOwner,
    });
    const now = Date.now();
    const enrollment: EnrollmentState = {
      id: randomUUID(),
      personId: person.id,
      personName: person.name,
      relation: person.relation,
      sessionId: input.sessionId,
      status: "collecting",
      acceptedSamples: 0,
      startedAt: now,
      updatedAt: now,
    };
    this.sessions.set(enrollment.id, enrollment);
    return structuredClone(enrollment);
  }

  get(enrollmentId: string): EnrollmentState | undefined {
    const state = this.sessions.get(enrollmentId);
    return state ? structuredClone(state) : undefined;
  }

  ingest(enrollmentId: string, observation: SpeakerObservation): { state: EnrollmentState; profile?: VoiceProfile } {
    const state = this.sessions.get(enrollmentId);
    if (!state) throw new Error(`声纹注册会话不存在：${enrollmentId}`);
    if (state.status !== "collecting") return { state: structuredClone(state) };
    if (!observation.embedding) return { state: structuredClone(state) };
    if (observation.confidence < 0.65 || observation.speechDurationMs < 700) {
      return { state: structuredClone(state) };
    }

    // 首个稳定说话人会被绑定为本次注册对象，后续若 Speaker ID 突然变化则拒绝样本，
    // 避免多人场景中把不同人的声音混入同一个 Voice Profile。
    if (!state.sessionSpeakerId) {
      state.sessionSpeakerId = observation.sessionSpeakerId;
    } else if (state.sessionSpeakerId !== observation.sessionSpeakerId) {
      return { state: structuredClone(state) };
    }

    const profile = this.store.addVoiceSample({
      personId: state.personId,
      embedding: observation.embedding,
      sourceSessionId: state.sessionId,
      environment: observation.environment?.scene,
      proximity: observation.proximity,
      quality: observation.confidence,
    });

    state.acceptedSamples = profile.samples.length;
    state.updatedAt = Date.now();
    if (profile.status === "confirmed") state.status = "confirmed";

    return {
      state: structuredClone(state),
      profile,
    };
  }

  cancel(enrollmentId: string): EnrollmentState | undefined {
    const state = this.sessions.get(enrollmentId);
    if (!state) return undefined;
    state.status = "cancelled";
    state.updatedAt = Date.now();
    return structuredClone(state);
  }
}
