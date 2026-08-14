package cn.mv3.aipany

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
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

    @Test
    fun `Chat2API websocket 403 is diagnosed as authorization rejection`() {
        val snapshot = LiveDiagnosticsSnapshot(
            gatewayState = "安全连接已建立，正在启动实时语音",
            upstreamState = "unavailable",
            upstreamDetail = "WebSocket closed (1006)",
            model = "gpt-live",
            recoveryAttempt = 0,
            lastReadyAtMs = 0,
            lastError = "WebSocket closed (1006)",
            androidAudioState = "audio_ready",
            androidAudioDetail = "Android audio ready",
            lastAudioReadyAtMs = 1,
            lastAudioError = "",
            latency = LiveLatencySnapshot(),
            updatedAtMs = 2,
            events = listOf(
                LiveDiagnosticEvent(1, "upstream", "connecting", "正在连接 Chat2API GPT-Live bridge", 0, "gpt-live"),
                LiveDiagnosticEvent(2, "upstream", "unavailable", "Unexpected server response: 403", 0, "gpt-live"),
                LiveDiagnosticEvent(3, "upstream", "unavailable", "WebSocket closed (1006)", 0, "gpt-live"),
            ),
        )
        val result = diagnoseLiveChain(
            snapshot,
            GatewayHealthSnapshot(true, "gateway", "test", "cascaded", true, "jwt"),
            "",
        )
        assertEquals(DiagnosticLayer.CHAT2API_BRIDGE, result.layer)
        assertEquals(DiagnosticSeverity.ERROR, result.severity)
        assertEquals(98, result.confidence)
        assertTrue(result.title.contains("鉴权"))
        assertTrue(result.actions.any { it.contains("audio") || it.contains("chat") })
    }
}
