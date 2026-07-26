package cn.mv3.aipany

/**
 * Binary WebSocket audio frames do not carry a response id. Control events still
 * let us keep two independent bounded windows:
 *
 * 1. the primary assistant response
 * 2. a short backchannel / latency-bridge cue
 *
 * A backchannel must never replace or clear the primary response state. Economy
 * Live can start the main TTS stream while the short bridge is still audible;
 * closing the bridge window must therefore leave the main response window open.
 */
class ResponseAudioGate {
    private var activeResponseId: String? = null
    private var responseAccepting = false
    private var responseCancelled = false
    private var backchannelAccepting = false

    @Synchronized
    fun onResponseCreated(responseId: String?) {
        activeResponseId = responseId?.takeIf { it.isNotBlank() }
        responseAccepting = false
        responseCancelled = false
    }

    @Synchronized
    fun onAudioStarted(responseId: String?): Boolean {
        val incoming = responseId?.takeIf { it.isNotBlank() }
        if (responseCancelled || activeResponseId == null) return false
        if (incoming != null && incoming != activeResponseId) return false
        responseAccepting = true
        return true
    }

    @Synchronized
    fun onBackchannelStarted() {
        backchannelAccepting = true
    }

    @Synchronized
    fun cancelLocally() {
        responseAccepting = false
        responseCancelled = true
        backchannelAccepting = false
    }

    @Synchronized
    fun onResponseFinished(responseId: String?) {
        val incoming = responseId?.takeIf { it.isNotBlank() }
        if (incoming == null || incoming == activeResponseId) clearResponse()
    }

    @Synchronized
    fun onBackchannelFinished() {
        backchannelAccepting = false
    }

    @Synchronized
    fun acceptsBinaryAudio(): Boolean = backchannelAccepting ||
        (responseAccepting && !responseCancelled && activeResponseId != null)

    @Synchronized
    fun reset() {
        clearResponse()
        backchannelAccepting = false
    }

    private fun clearResponse() {
        activeResponseId = null
        responseAccepting = false
        responseCancelled = false
    }
}
