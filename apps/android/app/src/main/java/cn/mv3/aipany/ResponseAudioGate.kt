package cn.mv3.aipany

/**
 * Binary WebSocket audio frames do not carry a response id. This gate therefore
 * opens only after a matching audio-start control event and closes locally before
 * a cancel frame is sent. Old upstream frames that arrive after a barge-in are
 * discarded instead of being interpreted as audio for the next turn.
 */
class ResponseAudioGate {
    private var activeStreamId: String? = null
    private var accepting = false
    private var cancelled = false

    @Synchronized
    fun onResponseCreated(responseId: String?) {
        activeStreamId = responseId?.takeIf { it.isNotBlank() }
        accepting = false
        cancelled = false
    }

    @Synchronized
    fun onAudioStarted(responseId: String?): Boolean {
        val incoming = responseId?.takeIf { it.isNotBlank() }
        if (cancelled || activeStreamId == null) return false
        if (incoming != null && incoming != activeStreamId) return false
        accepting = true
        return true
    }

    @Synchronized
    fun onBackchannelStarted() {
        activeStreamId = BACKCHANNEL_STREAM_ID
        accepting = true
        cancelled = false
    }

    @Synchronized
    fun cancelLocally() {
        accepting = false
        cancelled = true
    }

    @Synchronized
    fun onResponseFinished(responseId: String?) {
        val incoming = responseId?.takeIf { it.isNotBlank() }
        if (incoming == null || incoming == activeStreamId) clear()
    }

    @Synchronized
    fun onBackchannelFinished() {
        if (activeStreamId == BACKCHANNEL_STREAM_ID) clear()
    }

    @Synchronized
    fun acceptsBinaryAudio(): Boolean = accepting && !cancelled && activeStreamId != null

    @Synchronized
    fun reset() {
        clear()
    }

    private fun clear() {
        activeStreamId = null
        accepting = false
        cancelled = false
    }

    companion object {
        private const val BACKCHANNEL_STREAM_ID = "__aipany_backchannel__"
    }
}
