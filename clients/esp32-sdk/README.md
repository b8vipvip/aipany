# ESP32 SDK Placeholder

This directory reserves the future embedded client SDK boundary.

The ESP32 client should implement the same platform concepts as the mobile client:

- device registration and capability reporting;
- authenticated session bootstrap;
- realtime audio transport;
- session and speech-state events from `@aipany/protocol`;
- device command handling;
- connectivity and firmware metadata.

The first target is expected to be ESP32-S3-class hardware. The transport adapter may differ from mobile, but Agent, Memory, Tool, Device, and Usage contracts must remain shared.

No embedded implementation is required for the mobile V1 milestone.
