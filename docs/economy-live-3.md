# Economy Live 3: resilience and prosody

This iteration is driven by sanitized production observability from Android 0.3.0.

## Reliability

- Client telemetry names use a bounded forward-compatible snake_case schema, so a new APK metric cannot become a user-visible `INVALID_EVENT` error.
- A suppressed local endpoint no longer leaves the UI pretending that an ASR request is pending.
- Server-confirmed interruption no longer flushes Android playback a second time.
- Live routing caps first-token silence only when another enabled route exists; single-provider deployments retain their configured timeout.

## Expressive speech

For Qwen-Audio-TTS inference models, the Humanizer's coarse safe style is mapped to narrow per-turn numeric controls:

- `rate` remains close to natural speed.
- `pitch` changes subtly to preserve voice identity.
- `volume` changes modestly with energy.
- A per-task seed avoids identical repeated cadence while remaining within the provider's documented range.

Legacy Qwen realtime TTS keeps its existing instruction-only behavior because that protocol does not support the same numeric controls.

## Privacy

Observability includes model, voice, protocol family, coarse style, numeric prosody, and instruction hash. It never includes transcript text or TTS instruction text.
