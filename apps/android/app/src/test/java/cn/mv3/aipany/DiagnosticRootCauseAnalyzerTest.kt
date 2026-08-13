package cn.mv3.aipany

import org.junit.Assert.assertEquals
import org.junit.Test

class DiagnosticRootCauseAnalyzerTest {
    @Test
    fun `bridge connected waits for Voice ready`() {
        val snapshot = LiveDiagnosticsSnapshot(
            gatewayState = "connected",
            upstreamState = "bridge_connected",
            upstreamDetail = "waiting for Voice ready",
            model = "gpt-live",
            recoveryAttempt = 0,
            lastReadyAtMs = 0,
            lastError = "",
            androidAudioState = "unknown",
            androidAudioDetail = "",
            lastAudioReadyAtMs = 0,
            lastAudioError = "",
            latency = LiveLatencySnapshot(),
            updatedAtMs = 1,
            events = emptyList(),
        )
        val result = diagnoseLiveChain(
            snapshot,
            GatewayHealthSnapshot(true, "gateway", "test", "omni_realtime", true, "jwt"),
            "",
        )
        assertEquals(DiagnosticLayer.CHATGPT_VOICE, result.layer)
    }
}
