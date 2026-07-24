package cn.mv3.aipany

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ResponseAudioGateTest {
    @Test
    fun blocksAudioUntilMatchingStartEvent() {
        val gate = ResponseAudioGate()
        gate.onResponseCreated("response-1")
        assertFalse(gate.acceptsBinaryAudio())
        assertFalse(gate.onAudioStarted("response-2"))
        assertTrue(gate.onAudioStarted("response-1"))
        assertTrue(gate.acceptsBinaryAudio())
    }

    @Test
    fun localCancelDropsAllLateFramesUntilNextResponseStarts() {
        val gate = ResponseAudioGate()
        gate.onResponseCreated("response-1")
        gate.onAudioStarted("response-1")
        assertTrue(gate.acceptsBinaryAudio())

        gate.cancelLocally()
        assertFalse(gate.acceptsBinaryAudio())
        assertFalse(gate.onAudioStarted("response-1"))

        gate.onResponseCreated("response-2")
        assertFalse(gate.acceptsBinaryAudio())
        assertTrue(gate.onAudioStarted("response-2"))
        assertTrue(gate.acceptsBinaryAudio())
    }

    @Test
    fun backchannelHasItsOwnBoundedAudioWindow() {
        val gate = ResponseAudioGate()
        gate.onBackchannelStarted()
        assertTrue(gate.acceptsBinaryAudio())
        gate.onBackchannelFinished()
        assertFalse(gate.acceptsBinaryAudio())
    }
}
