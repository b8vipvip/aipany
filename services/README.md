# Services

Aipany backend services are organized by domain boundaries rather than by client platform.

Planned service modules:

- `api-gateway` — authentication, tenant/product/device context, rate limits, routing;
- `voice-session` — realtime provider adapters, session lifecycle, interruption state;
- `agent` — personas, system instructions, voice and conversation policies;
- `memory` — long-term memory extraction, retrieval, editing, deletion and summaries;
- `tools` — tool registry, execution, MCP, knowledge retrieval and business APIs;
- `device` — registration, capabilities, online state and future OTA metadata;
- `billing` — usage attribution, quotas and future tenant billing.

V1 may initially deploy several of these modules inside one backend process. The code boundaries should still follow these domains so they can be split later without rewriting contracts.
