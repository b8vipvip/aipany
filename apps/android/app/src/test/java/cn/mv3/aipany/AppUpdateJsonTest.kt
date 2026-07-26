package cn.mv3.aipany

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test

class AppUpdateJsonTest {
    @Test
    fun parsesSignedHttpsUpdateManifest() {
        val info = AppUpdateJson.parse(
            """
            {
              "versionCode": 10123,
              "versionName": "0.4.123",
              "downloadUrl": "https://github.com/b8vipvip/aipany/releases/download/android-latest/Aipany.apk",
              "sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
              "releaseNotes": "设置界面与语音体验优化",
              "mandatory": false,
              "publishedAt": "2026-07-25T10:00:00Z"
            }
            """.trimIndent(),
        )

        assertEquals(10123, info.versionCode)
        assertEquals("0.4.123", info.versionName)
        assertEquals("设置界面与语音体验优化", info.releaseNotes)
        assertFalse(info.mandatory)
    }

    @Test(expected = IllegalArgumentException::class)
    fun rejectsNonHttpsDownloadUrl() {
        AppUpdateJson.parse(
            """
            {
              "versionCode": 10123,
              "versionName": "0.4.123",
              "downloadUrl": "http://example.com/Aipany.apk",
              "sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
            }
            """.trimIndent(),
        )
    }

    @Test(expected = IllegalArgumentException::class)
    fun rejectsInvalidSha256() {
        AppUpdateJson.parse(
            """
            {
              "versionCode": 10123,
              "versionName": "0.4.123",
              "downloadUrl": "https://example.com/Aipany.apk",
              "sha256": "not-a-sha"
            }
            """.trimIndent(),
        )
    }
}
