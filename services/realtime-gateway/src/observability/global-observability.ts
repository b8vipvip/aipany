import type { ObservabilityLevel, RealtimeObservabilityStore } from "./realtime-observability.js";

let activeStore: RealtimeObservabilityStore | undefined;

export function setGlobalRealtimeObservabilityStore(store: RealtimeObservabilityStore | undefined): void {
  activeStore = store;
}

export function recordGlobalRealtimeEvent(input: {
  level: ObservabilityLevel;
  category: string;
  event: string;
  sessionId?: string;
  connectionId?: string;
  engine?: "cascaded" | "omni_realtime";
  data?: Record<string, unknown>;
}): void {
  activeStore?.record(input);
}
