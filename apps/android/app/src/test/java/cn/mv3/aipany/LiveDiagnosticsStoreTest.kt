package cn.mv3.aipany

import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

class LiveDiagnosticsStoreTest {
    @Before
    fun setUp() {
        LiveDiagnosticsStore.clear()
    }

    @After
    fun tearDown() {
        LiveDiagnosticsStore.clear()
    }

    @Test
    fun tracksReadyRecoveryAndLastError() {
        LiveDiagnosticsStore.recordGateway("安全连接已建立，正在启动实时语音", nowMs = 1_000L)
        LiveDiagnosticsStore.recordUpstream("bridge_connected", "bridge online", model = "gpt-live", nowMs = 2_000L)
        LiveDiagnosticsStore.recordUpstream("ready", "voice ready", model = "gpt-live", nowMs = 3_000L)
        LiveDiagnosticsStore.recordUpstream("recovering", "自动恢复第 2/3 次", attempt = 2, model = "gpt-live", nowMs = 4_000L)
        LiveDiagnosticsStore.recordUpstream("unavailable", "heartbeat timeout", attempt = 3, model = "gpt-live", nowMs = 5_000L)

        val snapshot = LiveDiagnosticsStore.snapshot()
        assertEquals("unavailable", snapshot.upstreamState)
        assertEquals("gpt-live", snapshot.model)
        assertEquals(3, snapshot.recoveryAttempt)
        assertEquals(3_000L, snapshot.lastReadyAtMs)
        assertEquals("heartbeat timeout", snapshot.lastError)
        assertTrue(snapshot.events.size >= 5)
    }

    @Test
    fun ignoresOtherUpstreamProviders() {
        LiveDiagnosticsStore.recordUpstream(
            JSONObject()
                .put("provider", "qwen")
                .put("state", "ready"),
            nowMs = 10L,
        )
        assertEquals("unknown", LiveDiagnosticsStore.snapshot().upstreamState)
    }

    @Test
    fun deduplicatesIdenticalAdjacentEvents() {
        LiveDiagnosticsStore.recordUpstream("connecting", "same", nowMs = 10L)
        LiveDiagnosticsStore.recordUpstream("connecting", "same", nowMs = 20L)
        assertEquals(1, LiveDiagnosticsStore.snapshot().events.size)
    }
}
