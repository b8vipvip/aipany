package cn.mv3.aipany

/** Process-local bridge for protocol events that need to adjust AudioEngine state. */
object ClientAudioControlBus {
    @Volatile private var setAssistantSpeaking: ((Boolean) -> Unit)? = null
    @Volatile private var interruptPlayback: (() -> Unit)? = null

    fun attach(
        onAssistantSpeaking: (Boolean) -> Unit,
        onInterruptPlayback: () -> Unit,
    ) {
        setAssistantSpeaking = onAssistantSpeaking
        interruptPlayback = onInterruptPlayback
    }

    fun detach() {
        setAssistantSpeaking = null
        interruptPlayback = null
    }

    fun assistantSpeaking(value: Boolean) {
        setAssistantSpeaking?.invoke(value)
    }

    fun interrupt() {
        interruptPlayback?.invoke()
    }
}
