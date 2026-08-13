package cn.mv3.aipany

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class DiagnosticRedactionTest {
    @Test
    fun `report redaction removes sensitive values`() {
        val redacted = redactDiagnosticText("gpt-live api_key=value123 https://example.invalid/path")
        assertTrue(redacted.contains("gpt-live"))
        assertTrue(redacted.contains("<redacted>"))
        assertTrue(redacted.contains("<redacted-url>"))
        assertFalse(redacted.contains("value123"))
        assertFalse(redacted.contains("example.invalid"))
    }
}
