package cn.mv3.aipany

import org.junit.Assert.assertTrue
import org.junit.Test

class AudioStartupTelemetryContractTest {
    @Test
    fun telemetryNamesRemainForwardCompatibleSnakeCase() {
        val names = listOf(
            "session_ready_received",
            "audio_start_requested",
            "audio_start_ready",
            "audio_start_failed",
            "audio_start_timeout",
            "android_previous_crash",
        )
        assertTrue(names.all { it.matches(Regex("[a-z][a-z0-9_]{2,63}")) })
    }
}
