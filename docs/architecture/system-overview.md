# Aipany System Architecture

## 1. Goal

Aipany is a device-agnostic realtime AI voice platform. The first client is a mobile application. Future clients may include ESP32-S3 boards, smart speakers, toys, robots, and other embedded devices without replacing the AI backend.

The platform must optimize for:

- low-latency full-duplex voice interaction;
- immediate interruption and response cancellation;
- provider abstraction for realtime voice models;
- reusable agents, memory, tools, and knowledge across devices;
- secure server-side control of credentials and business logic;
- eventual multi-tenant support for hardware vendors.

## 2. Core architecture

```text
Mobile App / Web / ESP32 / Robot
              |
              | Device Session Protocol
              v
        API & Session Gateway
              |
       +------+-------+
       |              |
       v              v
Realtime Voice     AI Brain
Transport          Orchestrator
       |              |
       |              +--> Agent configuration
       |              +--> Long-term memory
       |              +--> Knowledge / RAG
       |              +--> Tools / MCP / APIs
       |              +--> Deep-task models
       |              +--> Safety / policy hooks
       |              +--> Usage accounting
       |
       v
Realtime Voice Provider
```

The realtime provider is replaceable. Device clients do not directly own provider business credentials. The server creates or brokers short-lived session credentials and remains attached to the session through a control channel when supported.

## 3. Architectural rule: App is a Device

The backend must never assume that a realtime session belongs to a phone. Every client registers a `DeviceIdentity` with capabilities.

Examples:

```json
{
  "deviceId": "dev_mobile_123",
  "productId": "aipany-mobile",
  "deviceType": "mobile",
  "platform": "ios",
  "capabilities": ["audio_input", "audio_output", "screen", "camera", "location"]
}
```

```json
{
  "deviceId": "dev_esp32_456",
  "productId": "toy-v1",
  "deviceType": "embedded",
  "platform": "esp32-s3",
  "capabilities": ["audio_input", "audio_output", "led", "button", "ota"]
}
```

Agents and tools inspect capabilities before attempting device actions.

## 4. Realtime conversation path

```text
1. Client authenticates with Aipany.
2. Client registers or refreshes its device identity.
3. Client requests a voice session.
4. Voice Session Service selects provider, model policy, agent, and voice.
5. Server returns short-lived session bootstrap data.
6. Client establishes the realtime media connection.
7. Server attaches its control/sideband connection when available.
8. User audio streams continuously.
9. Realtime model handles conversational timing and natural speech.
10. Complex tasks are delegated to AI Brain tools or deeper models.
11. Results return to the realtime model for natural spoken delivery.
12. Session events and usage are persisted asynchronously.
```

## 5. Interruption model

Barge-in is a first-class state transition, not a UI feature.

When user speech starts while assistant audio is playing:

```text
user.speech.started
        |
        +--> stop or duck local playback immediately
        +--> cancel active assistant response
        +--> truncate unheard assistant context when supported
        +--> mark assistant.speech.interrupted
        +--> continue receiving user speech
```

The mobile client should react locally before waiting for a server round-trip.

## 6. Service boundaries

### API Gateway

Authentication, rate limits, request routing, product/device context.

### Device Service

Device registration, capabilities, product association, online status, future firmware and OTA metadata.

### Voice Session Service

Realtime provider abstraction, short-lived credential creation, session lifecycle, transport metadata, interruption state, transcript events.

### Agent Service

Persona, system instructions, voice settings, reply style, initiative policy, memory policy, enabled tools.

### Memory Service

User profile facts, preferences, relationships, projects, episodic memories, conversation summaries, retrieval and forgetting policy.

### Tool Service

Tool registry and execution for web/search providers, knowledge retrieval, MCP, business APIs, and device commands.

### Usage & Billing Service

Session duration, provider usage, model usage, tenant/product attribution, quotas and future billing.

## 7. Data model direction

Initial primary entities:

- User
- Tenant
- Product
- Device
- Agent
- VoiceSession
- Conversation
- ConversationTurn
- Memory
- ToolDefinition
- ToolExecution
- UsageRecord

`Tenant` can initially represent Aipany itself, allowing multi-tenant hardware vendors later without redesigning the schema.

## 8. Provider abstraction

Do not expose provider-native event names throughout the product codebase. Normalize them into `@aipany/protocol` events.

Recommended interface:

```text
RealtimeProvider
  createSession()
  attachControlChannel()
  updateSession()
  cancelResponse()
  truncateResponse()
  sendToolResult()
  closeSession()
```

A provider adapter translates native events into the Aipany protocol.

## 9. V1 non-goals

The first release will not implement:

- ESP32 firmware;
- hardware-vendor billing;
- production OTA infrastructure;
- a public SDK marketplace;
- every realtime model provider.

The architecture preserves these paths while V1 concentrates on excellent mobile voice interaction.
