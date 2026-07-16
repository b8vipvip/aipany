# Aipany

Aipany is a mobile-first realtime AI voice platform designed to grow into a reusable voice cloud for ESP32-S3 devices, smart speakers, toys, robots, and third-party hardware.

> Status: architecture bootstrap and V1 realtime voice foundation.

The first product milestone is a mobile voice companion with low-latency, interruptible, continuous conversation. The backend is intentionally device-agnostic so future embedded clients can reuse the same Agent, Memory, Tool, Device, and Usage infrastructure.

## Product direction

- Realtime, interruptible speech-to-speech conversation
- Mobile-first client with future ESP32 support
- Agent personas and configurable voices
- Long-term user memory
- Tool calling, knowledge retrieval, and deep-task delegation
- Multi-device session and capability model
- Future multi-tenant hardware-vendor platform

## Architecture principle

**The mobile app is a Device, not a special-case client.**

Every client joins the platform through a common Device + Session abstraction and reports its capabilities. Mobile, web, ESP32, smart speakers, and robots may use different media transports while sharing the same AI Brain and platform services.

## Repository structure

```text
apps/
  mobile/             # first realtime voice client
  admin-web/          # future management console

clients/
  esp32-sdk/          # reserved embedded client SDK boundary

firmware/
  esp32/              # future ESP32-S3 reference firmware

services/             # backend domain boundaries

packages/
  protocol/           # shared versioned device/session event contracts

docs/
  architecture/       # system design
  roadmap/            # delivery plan
```

## Current foundation

The bootstrap branch introduces:

- pnpm + Turborepo monorepo configuration;
- shared strict TypeScript configuration;
- `@aipany/protocol` with device-agnostic session, speech, tool, and command events;
- mobile and ESP32 architectural boundaries;
- realtime voice / AI Brain system design;
- a staged V1 delivery roadmap.

## Start here

Read `docs/architecture/system-overview.md` for the platform design and `docs/roadmap/v1.md` for the implementation sequence.

## Security

Never embed permanent AI-provider credentials in mobile or embedded clients. Clients should receive short-lived session bootstrap credentials from Aipany's server. Real secrets belong only in server-side secret management and must never be committed to this repository.
