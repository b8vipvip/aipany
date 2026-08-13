package cn.mv3.aipany

data class InitialExperienceSelection(
    val experienceMode: String,
    val voiceId: String,
)

fun selectInitialExperience(capabilities: ClientCapabilities): InitialExperienceSelection {
    val chat2api = capabilities.mode("chat2api_live")
    val selected = when {
        chat2api?.engine == "omni_realtime" -> chat2api
        else -> {
            val serverDefault = capabilities.mode(capabilities.defaultExperienceMode)
            when {
                serverDefault?.engine == "omni_realtime" -> serverDefault
                serverDefault?.id == "economy_live" -> serverDefault
                else -> capabilities.experienceModes.firstOrNull { it.engine == "omni_realtime" }
                    ?: capabilities.mode("economy_live")
                    ?: capabilities.experienceModes.firstOrNull()
            }
        }
    }

    if (selected == null) {
        return InitialExperienceSelection(
            experienceMode = capabilities.defaultExperienceMode.ifBlank { "economy_live" },
            voiceId = capabilities.defaultVoice,
        )
    }

    val voice = selected.defaultVoice
        .takeIf { candidate -> selected.voices.any { it.id == candidate } }
        ?: selected.voices.firstOrNull()?.id
        ?: capabilities.defaultVoice

    return InitialExperienceSelection(selected.id, voice)
}
