package cn.mv3.aipany

import org.junit.Assert.assertEquals
import org.junit.Test

class InitialExperienceSelectorTest {
    @Test
    fun prefersAvailableChat2ApiLiveOnFirstRun() {
        val capabilities = capabilities(
            defaultExperienceMode = "native_plus",
            modes = listOf(
                mode("economy_live", "cascaded", "Cherry"),
                mode("chat2api_live", "omni_realtime", "chatgpt-current", model = "gpt-live"),
                mode("native_plus", "cascaded", "longanqian"),
            ),
        )

        val selected = selectInitialExperience(capabilities)

        assertEquals("chat2api_live", selected.experienceMode)
        assertEquals("chatgpt-current", selected.voiceId)
    }

    @Test
    fun fallsBackToAvailableServerNativeModeWhenChat2ApiIsDisabled() {
        val capabilities = capabilities(
            defaultExperienceMode = "native_plus",
            modes = listOf(
                mode("economy_live", "cascaded", "Cherry"),
                mode("chat2api_live", "cascaded", "chatgpt-current", model = "gpt-live"),
                mode("native_plus", "omni_realtime", "longanqian"),
            ),
        )

        val selected = selectInitialExperience(capabilities)

        assertEquals("native_plus", selected.experienceMode)
        assertEquals("longanqian", selected.voiceId)
    }

    @Test
    fun fallsBackToEconomyWhenNoNativeProviderIsAvailable() {
        val capabilities = capabilities(
            defaultExperienceMode = "native_plus",
            modes = listOf(
                mode("economy_live", "cascaded", "Cherry"),
                mode("chat2api_live", "cascaded", "chatgpt-current", model = "gpt-live"),
                mode("native_plus", "cascaded", "longanqian"),
            ),
        )

        val selected = selectInitialExperience(capabilities)

        assertEquals("economy_live", selected.experienceMode)
        assertEquals("Cherry", selected.voiceId)
    }

    private fun capabilities(
        defaultExperienceMode: String,
        modes: List<ClientExperienceModeOption>,
    ): ClientCapabilities = ClientCapabilities(
        previewEnabled = true,
        defaultVoice = "longanqian",
        defaultExperienceMode = defaultExperienceMode,
        voices = emptyList(),
        experienceModes = modes,
    )

    private fun mode(
        id: String,
        engine: String,
        voiceId: String,
        model: String = id,
    ): ClientExperienceModeOption = ClientExperienceModeOption(
        id = id,
        title = id,
        subtitle = "",
        engine = engine,
        model = model,
        defaultVoice = voiceId,
        voices = listOf(ClientVoiceOption(voiceId, voiceId, "neutral", "")),
    )
}
