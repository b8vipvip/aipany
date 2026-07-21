package cn.mv3.aipany

import android.content.Context
import okhttp3.Call
import okhttp3.Callback
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.util.concurrent.TimeUnit

data class ClientVoiceOption(
    val id: String,
    val name: String,
    val gender: String,
    val description: String,
) {
    fun displayName(): String = "$name · ${if (gender == "male") "男声" else "女声"}"
}

data class ClientCapabilities(
    val previewEnabled: Boolean,
    val defaultVoice: String,
    val voices: List<ClientVoiceOption>,
)

data class BootstrapSession(
    val token: String,
    val tenantId: String,
    val userId: String,
    val websocketPath: String,
)

class MobileApiClient(
    private val baseUrl: String = BASE_URL,
) {
    private val client = OkHttpClient.Builder()
        .connectTimeout(12, TimeUnit.SECONDS)
        .readTimeout(15, TimeUnit.SECONDS)
        .retryOnConnectionFailure(true)
        .build()

    fun fetchCapabilities(callback: (Result<ClientCapabilities>) -> Unit) {
        val request = Request.Builder()
            .url("${baseUrl.trimEnd('/')}/v1/mobile/capabilities")
            .get()
            .build()
        client.newCall(request).enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) = callback(Result.failure(e))

            override fun onResponse(call: Call, response: Response) {
                response.use {
                    val body = it.body?.string().orEmpty()
                    if (!it.isSuccessful) {
                        callback(Result.failure(IllegalStateException("HTTP ${it.code}: $body")))
                        return
                    }
                    try {
                        val json = JSONObject(body)
                        val voicesJson = json.optJSONArray("voices") ?: JSONArray()
                        val voices = buildList {
                            for (index in 0 until voicesJson.length()) {
                                val item = voicesJson.optJSONObject(index) ?: continue
                                add(
                                    ClientVoiceOption(
                                        id = item.optString("id"),
                                        name = item.optString("name", item.optString("id")),
                                        gender = item.optString("gender", "female"),
                                        description = item.optString("description"),
                                    ),
                                )
                            }
                        }
                        callback(
                            Result.success(
                                ClientCapabilities(
                                    previewEnabled = json.optBoolean("previewEnabled", false),
                                    defaultVoice = json.optJSONObject("defaults")?.optString("outputVoice", "Cherry") ?: "Cherry",
                                    voices = voices,
                                ),
                            ),
                        )
                    } catch (error: Exception) {
                        callback(Result.failure(error))
                    }
                }
            }
        })
    }

    fun bootstrap(deviceId: String, callback: (Result<BootstrapSession>) -> Unit) {
        val json = JSONObject()
            .put("deviceId", deviceId)
            .put("platform", "android")
            .put("appVersion", BuildConfig.VERSION_NAME)
        val request = Request.Builder()
            .url("${baseUrl.trimEnd('/')}/v1/mobile/bootstrap")
            .post(json.toString().toRequestBody(JSON_MEDIA_TYPE))
            .build()
        client.newCall(request).enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) = callback(Result.failure(e))

            override fun onResponse(call: Call, response: Response) {
                response.use {
                    val body = it.body?.string().orEmpty()
                    if (!it.isSuccessful) {
                        val code = runCatching { JSONObject(body).optString("error") }.getOrDefault("")
                        val message = when (code) {
                            "mobile_preview_disabled" -> "服务器尚未开启移动端预览模式"
                            "mobile_preview_requires_jwt" -> "服务器未配置 JWT，无法签发移动端会话"
                            "rate_limited" -> "连接请求过于频繁，请稍后再试"
                            else -> "移动端会话初始化失败：HTTP ${it.code}"
                        }
                        callback(Result.failure(IllegalStateException(message)))
                        return
                    }
                    try {
                        val data = JSONObject(body)
                        callback(
                            Result.success(
                                BootstrapSession(
                                    token = data.getString("token"),
                                    tenantId = data.getString("tenantId"),
                                    userId = data.getString("userId"),
                                    websocketPath = data.optString("websocketPath", "/v1/realtime"),
                                ),
                            ),
                        )
                    } catch (error: Exception) {
                        callback(Result.failure(error))
                    }
                }
            }
        })
    }

    fun websocketUrl(path: String): String {
        val host = baseUrl
            .replaceFirst("https://", "wss://")
            .replaceFirst("http://", "ws://")
            .trimEnd('/')
        return "$host/${path.trimStart('/')}"
    }

    fun release() {
        client.dispatcher.executorService.shutdown()
        client.connectionPool.evictAll()
    }

    companion object {
        const val BASE_URL = "https://aipany.mv3.cn"
        private val JSON_MEDIA_TYPE = "application/json; charset=utf-8".toMediaType()
    }
}

object ClientCapabilitiesCache {
    private const val PREFS = "aipany_capabilities"

    fun save(context: Context, capabilities: ClientCapabilities) {
        val voices = JSONArray()
        capabilities.voices.forEach { voice ->
            voices.put(
                JSONObject()
                    .put("id", voice.id)
                    .put("name", voice.name)
                    .put("gender", voice.gender)
                    .put("description", voice.description),
            )
        }
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
            .putString("default_voice", capabilities.defaultVoice)
            .putString("voices", voices.toString())
            .apply()
    }

    fun loadVoices(context: Context): List<ClientVoiceOption> {
        val raw = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString("voices", null) ?: return fallbackVoices()
        return runCatching {
            val array = JSONArray(raw)
            buildList {
                for (index in 0 until array.length()) {
                    val item = array.getJSONObject(index)
                    add(
                        ClientVoiceOption(
                            item.getString("id"),
                            item.optString("name", item.getString("id")),
                            item.optString("gender", "female"),
                            item.optString("description"),
                        ),
                    )
                }
            }
        }.getOrElse { fallbackVoices() }
    }

    private fun fallbackVoices(): List<ClientVoiceOption> = listOf(
        ClientVoiceOption("Cherry", "芊悦", "female", "阳光积极、亲切自然"),
        ClientVoiceOption("Serena", "苏瑶", "female", "温柔自然"),
        ClientVoiceOption("Ethan", "晨煦", "male", "阳光温暖"),
        ClientVoiceOption("Maia", "四月", "female", "知性温柔"),
        ClientVoiceOption("Kai", "凯", "male", "舒缓耐听"),
    )
}
