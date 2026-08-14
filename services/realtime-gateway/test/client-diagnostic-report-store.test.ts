import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ClientDiagnosticReportStore } from "../src/observability/client-diagnostic-report-store.js";

test("client diagnostic reports are persisted, listed and redacted again on the server", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "aipany-client-diagnostics-"));
  try {
    const store = new ClientDiagnosticReportStore({ directory, maxReports: 20 });
    const saved = await store.save({
      schema: "aipany-live-diagnostics-v1",
      generatedAtMs: 1786695879360,
      generatedAt: "2026-08-14T16:24:39.360+0800",
      app: { version: "0.4.119", versionCode: 10119 },
      device: { manufacturer: "vivo", model: "V2231A", androidSdk: 34, deviceId: "must-not-survive" },
      diagnosis: {
        layer: "chat2api_bridge",
        severity: "error",
        confidence: 98,
        title: "Chat2API WebSocket 鉴权/访问被拒绝",
      },
      session: {
        upstreamDetail: "Unexpected server response: 403",
        maliciousUrl: "https://secret.example/v1?token=abc",
        api_key: "super-secret",
        nested: { Authorization: "Bearer hidden-token" },
      },
      privacy: { apiKeysIncluded: false, deviceIdIncluded: false, urlsRedacted: true },
    });

    assert.equal(saved.appVersion, "0.4.119");
    assert.equal(saved.diagnosisLayer, "chat2api_bridge");
    assert.equal(saved.severity, "error");

    const reports = await store.list();
    assert.equal(reports.length, 1);
    assert.equal(reports[0]?.id, saved.id);
    assert.equal(reports[0]?.manufacturer, "vivo");

    const report = await store.read(saved.id);
    const serialized = JSON.stringify(report);
    assert.equal(serialized.includes("must-not-survive"), false);
    assert.equal(serialized.includes("super-secret"), false);
    assert.equal(serialized.includes("hidden-token"), false);
    assert.equal(serialized.includes("secret.example"), false);
    assert.equal(serialized.includes("Unexpected server response: 403"), true);
    assert.equal((report.privacy as Record<string, unknown>).apiKeysIncluded, false);

    const rawFile = await readFile(path.join(directory, `${saved.id}.json`), "utf8");
    assert.equal(rawFile.includes("super-secret"), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("client diagnostic report store rejects unknown schemas", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "aipany-client-diagnostics-schema-"));
  try {
    const store = new ClientDiagnosticReportStore({ directory });
    await assert.rejects(() => store.save({ schema: "unknown" }), /schema/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
