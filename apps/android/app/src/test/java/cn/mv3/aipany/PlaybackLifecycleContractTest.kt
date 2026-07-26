package cn.mv3.aipany

import org.junit.Assert.assertTrue
import org.junit.Test

class PlaybackLifecycleContractTest {
    @Test
    fun `client audio bus can distinguish gateway completion from local playback`() {
        var playbackActive = true
        ClientAudioControlBus.attach(
            onAssistantSpeaking = { requested ->
                // A false gateway state may be delayed by AudioEngine until queued PCM drains.
                if (requested) playbackActive = true
            },
            onInterruptPlayback = { playbackActive = false },
            isPlaybackActive = { playbackActive },
        )

        ClientAudioControlBus.assistantSpeaking(false)
        assertTrue(ClientAudioControlBus.isPlaybackActive())
        ClientAudioControlBus.interrupt()
        assertTrue(!ClientAudioControlBus.isPlaybackActive())
        ClientAudioControlBus.detach()
    }
}
