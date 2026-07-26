package cn.mv3.aipany

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ClientAudioControlBusTest {
    @Test
    fun `playback query follows the actual audio engine state`() {
        var active = false
        var interrupted = false
        ClientAudioControlBus.attach(
            onAssistantSpeaking = { active = it },
            onInterruptPlayback = {
                interrupted = true
                active = false
            },
            isPlaybackActive = { active },
        )

        ClientAudioControlBus.assistantSpeaking(true)
        assertTrue(ClientAudioControlBus.isPlaybackActive())

        ClientAudioControlBus.interrupt()
        assertTrue(interrupted)
        assertFalse(ClientAudioControlBus.isPlaybackActive())

        ClientAudioControlBus.detach()
    }
}
