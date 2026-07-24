package cn.mv3.aipany

/**
 * Binary WebSocket audio frames do not carry a response id. This gate therefore
 * opens only after the matching response.audio.started event and closes locally
 * before a cancel frame is sent. Any old upstream frames that arrive after a
 * barge-in are discarded instead of being interpreted as audio for the next turn.
 */
class ResponseAudioGate {
    private var activeResponseId: String? = null
    private var accepting = false
    private var cancelled = false

    @Synchronized
    fun onResponseCreated(responseId: String?) {
        activeResponseId = responseId?.takeIf { it.isNotBlank() }
        accepting = false
        cancelled = false
    }

    @Synchronized
    fun onAudioStarted(responseId: String?): Boolean {
        val incoming = responseId?.takeIf { it.isNotBlank() }
        if (cancelled || activeResponseId == null) return false
        if (incoming != null && incoming != activeResponseId) return false
        accepting = true
        return true
    }

    @Synchronized
    fun cancelLocally() {
        accepting = false
        cancelled = true
    }

    @Synchronized
    fun onResponseFinished(responseId: String?) {
        val incoming = responseId?.takeIf { it.isNotBlank() }
        if (incoming == null || incoming == activeResponseId) {
            accepting = false
            activeResponseId = null
            cancelled = false
        }
    }

    @Synchronized
    fun acceptsBinaryAudio(): Boolean = accepting && !cancelled && activeResponseId != null

    @Synchronized
    fun reset() {
        activeResponseId = null
        accepting = false
        cancelled = false
    }
}
