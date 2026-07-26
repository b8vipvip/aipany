package cn.mv3.aipany

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class SettingsInitializationContractTest {
    @Test
    fun defaultSettingsAlwaysResolveToUsableValues() {
        val settings = AppSettings()
        assertTrue(settings.experienceMode.isNotBlank())
        assertTrue(settings.voiceId.isNotBlank())
        assertTrue(settings.aliases().isNotEmpty())
        assertEquals(EndpointProfile.BALANCED, settings.endpointProfile)
    }
}
