# Aipany Observability GitHub Inbox

This directory is reserved for **sanitized production diagnostics** uploaded by the Aipany realtime gateway.

The automatic uploader is disabled by default. It batches events instead of creating one Git commit per conversation turn.

## Privacy contract

Uploaded batches must not contain:

- conversation transcripts or assistant response text;
- raw audio or audio payloads;
- tenant IDs, user IDs, device IDs, device hashes, IP addresses, or User-Agent strings;
- API keys, GitHub tokens, authorization headers, passwords, cookies, or other secrets;
- raw realtime session IDs (only a one-way short hash is used for grouping related events).

Allowed diagnostic data includes event names, engine selection, close codes/reasons, error classes/messages after secret redaction, app/network metadata, counters, and timing measurements needed to analyze latency, reconnects, Native Live stability, and barge-in behavior.

## Repository visibility

The production uploader checks the target repository visibility before uploading. Public repositories are rejected unless an administrator explicitly enables the public-repository override in the Aipany control panel.

For production, use a dedicated private repository whenever possible. The main `b8vipvip/aipany` repository is public and should not receive production diagnostics unless the explicit override is intentionally enabled.

## Layout

Batches use this layout:

```text
ops/observability/
└── YYYY-MM-DD/
    └── <timestamp>-<uuid>.json
```

Each JSON file contains a schema version, generation time, privacy declaration, and a batch of sanitized observability events.
