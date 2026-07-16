# Mobile App

The mobile app is Aipany's first realtime voice device client.

## Initial stack

- React Native
- TypeScript
- native WebRTC integration
- shared types from `@aipany/protocol`

## V1 responsibilities

- microphone and audio-session permissions;
- realtime media connection;
- remote assistant audio playback;
- immediate local playback stop/duck on barge-in;
- session state and connection UI;
- live transcript rendering;
- device registration and capability reporting.

## Boundary

The app must not contain long-term memory, tool business logic, permanent AI-provider credentials, or provider-specific orchestration logic. Those belong on the server.
