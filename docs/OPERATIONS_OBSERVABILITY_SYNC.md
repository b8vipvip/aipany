# Operations Console Access & Observability GitHub Sync

## Control panel password protection

Aipany now has an application-level password switch for `/admin` and the admin APIs.

- Default: **disabled**.
- Disabled: the application itself allows direct access. Production deployments should still use reverse-proxy authentication, an IP allowlist, VPN/private network access, or enable the application password.
- Enabled: the browser must provide the configured control-panel password.
- The existing `AIPANY_ADMIN_TOKEN` remains accepted as a server-side recovery/root credential when password protection is enabled.
- The password is stored as a salted scrypt hash, never as plaintext.
- The password can be enabled, changed, or disabled from the control panel.

The access settings are stored separately from AI provider runtime configuration in:

```text
/data/operations-control.json
```

The path can be overridden with:

```text
AIPANY_OPERATIONS_CONTROL_PATH
```

## Observability GitHub sync

The gateway can mirror sanitized observability events to a GitHub repository for remote diagnosis.

The feature is disabled by default and must be configured from the control panel.

Recommended production setup:

1. Create a dedicated **private** GitHub repository for diagnostics.
2. Create a fine-grained GitHub token with only the minimum repository content permission required to write files to that repository.
3. Configure the repository, branch, destination path, token, and batch interval in the Aipany control panel.
4. Run the built-in GitHub connection test before enabling automatic sync.

The main `b8vipvip/aipany` repository is public. Automatic upload to a public repository is blocked unless the administrator explicitly enables the public-repository override.

### What is uploaded

The uploader batches structured diagnostic events needed to analyze:

- engine selection and fallback;
- WebSocket close codes and reasons;
- upstream/provider errors after secret redaction;
- latency measurements;
- reconnect and interruption events;
- application/network metadata when those fields are available in telemetry.

### What is never uploaded

The sanitizer removes:

- user transcripts and assistant response text;
- prompts and arbitrary content payloads;
- raw audio, PCM, Base64 audio, and audio payloads;
- tenant/user/device identifiers and device hashes;
- IP addresses and User-Agent strings;
- API keys, GitHub tokens, authorization headers, passwords, cookies, and other secrets;
- raw realtime Session IDs.

Session IDs are replaced with a short one-way SHA-256-derived hash only for grouping related diagnostic events.

### Upload layout

```text
<configured-path>/
└── YYYY-MM-DD/
    └── <timestamp>-<uuid>.json
```

Uploads are batched rather than creating a Git commit for every conversation turn. The local `/data/observability/events.jsonl` remains the primary local source of truth even if GitHub sync is disabled or temporarily fails.
