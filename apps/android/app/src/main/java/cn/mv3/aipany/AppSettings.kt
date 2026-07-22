package cn.mv3.aipany

import android.content.Context

data class AppSettings(
    val experienceMode: String = "native_plus",
    val voiceId: String = "longanqian",
    val interactionMode: String = "auto",
    val socialProactivity: Float = 0.45f,
    val assistantAliases: String = "Aipany,小派",
    val endpointProfile: EndpointProfile = EndpointProfile.BALANCED,
    val bargeInEnabled: Boolean = true,
    val showTranscript: Boolean = true,
) {
    fun aliases(): List<String> = assistantAliases
        .split(',', '，', ';', '；')
        .map { it.trim() }
        .filter { it.isNotEmpty() }
        .distinct()
        .take(12)
        .ifEmpty { listOf("Aipany", "小派") }

    companion object {
        private const val PREFS = "aipany_settings"

        fun load(context: Context): AppSettings {
            val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            return AppSettings(
                experienceMode = prefs.getString("experience_mode", "native_plus") ?: "native_plus",
                voiceId = prefs.getString("voice_id", "longanqian") ?: "longanqian",
                interactionMode = prefs.getString("interaction_mode", "auto") ?: "auto",
                socialProactivity = prefs.getFloat("social_proactivity", 0.45f).coerceIn(0f, 1f),
                assistantAliases = prefs.getString("assistant_aliases", "Aipany,小派") ?: "Aipany,小派",
                endpointProfile = EndpointProfile.fromKey(prefs.getString("endpoint_profile", null)),
                bargeInEnabled = prefs.getBoolean("barge_in", true),
                showTranscript = prefs.getBoolean("show_transcript", true),
            )
        }

        fun save(context: Context, value: AppSettings) {
            context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
                .putString("experience_mode", value.experienceMode)
                .putString("voice_id", value.voiceId)
                .putString("interaction_mode", value.interactionMode)
                .putFloat("social_proactivity", value.socialProactivity)
                .putString("assistant_aliases", value.assistantAliases)
                .putString("endpoint_profile", value.endpointProfile.key)
                .putBoolean("barge_in", value.bargeInEnabled)
                .putBoolean("show_transcript", value.showTranscript)
                .apply()
        }
    }
}

enum class EndpointProfile(
    val key: String,
    val title: String,
    val subtitle: String,
    val longSpeechSilenceFrames: Int,
    val mediumSpeechSilenceFrames: Int,
    val shortSpeechSilenceFrames: Int,
) {
    FAST("fast", "快速", "更快结束一轮，适合安静环境", 12, 14, 16),
    BALANCED("balanced", "平衡", "速度与误判之间的推荐设置", 14, 16, 18),
    STABLE("stable", "稳健", "更耐停顿，适合嘈杂环境", 18, 21, 24);

    companion object {
        fun fromKey(value: String?): EndpointProfile = entries.firstOrNull { it.key == value } ?: BALANCED
    }
}
