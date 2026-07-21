package cn.mv3.aipany

import org.junit.Assert.assertEquals
import org.junit.Test

class RealtimeClientTest {
    @Test
    fun normalizesGatewayUrls() {
        assertEquals(
            "wss://aipany.mv3.cn/v1/realtime",
            RealtimeClient.normalizeWebSocketUrl("https://aipany.mv3.cn"),
        )
        assertEquals(
            "wss://aipany.mv3.cn/v1/realtime",
            RealtimeClient.normalizeWebSocketUrl("wss://aipany.mv3.cn/v1/realtime"),
        )
        assertEquals(
            "ws://127.0.0.1:3000/v1/realtime",
            RealtimeClient.normalizeWebSocketUrl("http://127.0.0.1:3000"),
        )
    }
}
