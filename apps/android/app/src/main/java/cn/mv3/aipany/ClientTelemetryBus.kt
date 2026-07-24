package cn.mv3.aipany

/**
 * Process-local bridge used by the audio thread to report measurements through
 * the currently active RealtimeClient without coupling AudioEngine to networking.
 */
object ClientTelemetryBus {
    @Volatile private var sender: ((String, Double?) -> Unit)? = null

    fun attach(value: (String, Double?) -> Unit) {
        sender = value
    }

    fun detach() {
        sender = null
    }

    fun report(name: String, valueMs: Double? = null) {
        sender?.invoke(name, valueMs)
    }
}
