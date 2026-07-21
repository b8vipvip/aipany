package cn.mv3.aipany

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class EndpointDetectorTest {
    @Test
    fun longSpeechCommitsAfterAggressiveSilenceWindow() {
        var starts = 0
        var endpoints = 0
        val detector = EndpointDetector(
            onSpeechStarted = { starts++ },
            onEndpointDetected = { endpoints++ },
            onLevel = { _, _, _ -> },
        )

        repeat(20) { detector.process(frame(150), 320, false) }
        repeat(110) { detector.process(frame(5_000), 320, false) }
        repeat(13) { detector.process(frame(100), 320, false) }
        assertEquals(0, endpoints)
        detector.process(frame(100), 320, false)

        assertEquals(1, starts)
        assertEquals(1, endpoints)
    }

    @Test
    fun shortSpeechUsesSaferSilenceWindowAndDoesNotRepeatCommit() {
        var endpoints = 0
        val detector = EndpointDetector(
            onSpeechStarted = {},
            onEndpointDetected = { endpoints++ },
            onLevel = { _, _, _ -> },
        )

        repeat(20) { detector.process(frame(150), 320, false) }
        repeat(25) { detector.process(frame(5_000), 320, false) }
        repeat(17) { detector.process(frame(100), 320, false) }
        assertEquals(0, endpoints)
        detector.process(frame(100), 320, false)
        repeat(30) { detector.process(frame(100), 320, false) }

        assertEquals(1, endpoints)
    }

    @Test
    fun assistantPlaybackRejectsModerateEchoButAcceptsSustainedUserInterruption() {
        var starts = 0
        val detector = EndpointDetector(
            onSpeechStarted = { starts++ },
            onEndpointDetected = {},
            onLevel = { _, _, _ -> },
        )

        repeat(30) { detector.process(frame(120), 320, false) }
        repeat(10) { detector.process(frame(500), 320, true) }
        assertEquals(0, starts)

        repeat(3) { detector.process(frame(8_000), 320, true) }
        assertEquals(0, starts)
        detector.process(frame(8_000), 320, true)
        assertTrue(starts >= 1)
    }

    private fun frame(amplitude: Int): ShortArray = ShortArray(320) { index ->
        if (index % 2 == 0) amplitude.toShort() else (-amplitude).toShort()
    }
}
