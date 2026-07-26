package cn.mv3.aipany

/** Process-local bridge for protocol events that need to adjust AudioEngine state. */
object ClientAudioControlBus {
    @Volatile private var setAssistantSpeaking: ((Boolean) -> Unit)? = null
    @Volatile private var interruptPlayback: (() -> Unit)? = null
    @Volatile private var queryPlaybackActive: (() -> Boolean)? = null

    fun attach(
        onAssistantSpeaking: (Boolean) -> Unit,
        onInterruptPlayback: () -> Unit,
        isPlaybackActive: () -> Boolean,
    ) {
        setAssistantSpeaking = onAssistantSpeaking
        interruptPlayback = onInterruptPlayback
        queryPlaybackActive = isPlaybackActive
    }

    fun detach() {
        setAssistantSpeaking = null
        interruptPlayback = null
        queryPlaybackActive = null
    }

    fun assistantSpeaking(value: Boolean) {
        setAssistantSpeaking?.invoke(value)
    }

    fun isPlaybackActive(): Boolean = queryPlaybackActive?.invoke() == true

    fun interrupt() {
        interruptPlayback?.invoke()
    }
}
