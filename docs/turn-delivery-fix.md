# Economy Live turn delivery invariants

- `response.done` means the gateway has finished producing the response; it does not mean Android playback has drained.
- Android keeps playback marked active until queued PCM writes and the AudioTrack buffer have drained.
- Local speech start flushes buffered playback immediately before the network cancellation round trip.
- An adopted speculative LLM request may not complete a real user turn with zero tokens.
- Zero-token normal requests are retried once so a transcript stored in history is not silently left unanswered.
