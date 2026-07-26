# Android audio startup hotfix

The Android UI thread must never create or start `AudioRecord` or `AudioTrack`.

Production observability showed server-side `session.ready` in roughly 250 ms and healthy heartbeat RTT, while affected Android 0.4.80 sessions produced zero audio turns and later disconnected abnormally. The previous client called `audioEngine.start()` synchronously inside the main-thread `session.ready` handler. A slow or blocked vendor audio driver therefore left the UI displaying the preceding `session.created` state and could end in an ANR.

Invariants:

- audio-device initialization runs on a dedicated executor;
- an 8-second watchdog keeps the UI responsive and rebuilds the connection;
- stale startup completions cannot take ownership after reconnect or lifecycle invalidation;
- settings controls install listeners only after every dependent view exists;
- settings initialization failures render an in-app recovery screen instead of terminating the process;
- uncaught-crash breadcrumbs contain only exception class and app code location, never messages or conversation content.
