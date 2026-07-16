# Aipany

Aipany is an AI voice platform focused on low-latency, natural, realtime conversation across mobile apps today and embedded devices such as ESP32-S3 in the future.

> Status: early architecture and platform bootstrap.

The first milestone is a mobile voice companion application backed by a reusable realtime voice platform. The backend is intentionally device-agnostic so future ESP32 clients can share the same agent, memory, tools, billing, and session infrastructure.

## Product direction

- Realtime, interruptible speech-to-speech conversation
- Mobile-first client with future ESP32 support
- Agent personas and configurable voices
- Long-term user memory
- Tool calling, knowledge retrieval, and deep-task delegation
- Multi-device session and capability model
- Future multi-tenant hardware-vendor platform

## Repository structure

The detailed monorepo structure and implementation plan will be introduced in the first bootstrap pull request.
