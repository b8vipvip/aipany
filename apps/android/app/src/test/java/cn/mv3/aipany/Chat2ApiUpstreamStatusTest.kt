package cn.mv3.aipany

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class Chat2ApiUpstreamStatusTest {
    @Test
    fun showsBridgeAndVoiceReadinessSeparately() {
        val bridge = chat2ApiUpstreamUiStatus("bridge_connected")
        assertTrue(bridge.summary.contains("bridge 在线"))
        assertTrue(bridge.summary.contains("Voice 准备中"))

        val ready = chat2ApiUpstreamUiStatus("ready")
        assertTrue(ready.summary.contains("Voice 已就绪"))
        assertTrue(ready.summary.contains("GPT-Live 在线"))
    }

    @Test
    fun showsRecoveryAttempt() {
        val recovering = chat2ApiUpstreamUiStatus("recovering", "upstream closed", 2)
        assertTrue(recovering.summary.contains("第 2 次"))
        assertEquals("upstream closed", recovering.subtitle)
    }

    @Test
    fun keepsUnavailableStateActionable() {
        val unavailable = chat2ApiUpstreamUiStatus("unavailable")
        assertTrue(unavailable.summary.contains("等待恢复"))
        assertTrue(unavailable.subtitle.contains("自动重试"))
    }
}
