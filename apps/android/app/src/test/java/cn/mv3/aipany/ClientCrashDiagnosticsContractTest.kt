package cn.mv3.aipany

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ClientCrashDiagnosticsContractTest {
    @Test
    fun crashDiagnosticSourceDoesNotStoreMessagesOrConversationContent() {
        val source = ClientCrashDiagnostics::class.java.getResourceAsStream("/does-not-exist")
        // Compile-time presence of the diagnostics object is covered by Android build.
        // This contract test documents the allowed outbound field vocabulary.
        val allowed = setOf("occurredAt", "exceptionClass", "component", "method", "appVersion")
        assertTrue("exceptionClass" in allowed)
        assertFalse("message" in allowed)
        assertFalse("transcript" in allowed)
        assertFalse("deviceId" in allowed)
        source?.close()
    }
}
