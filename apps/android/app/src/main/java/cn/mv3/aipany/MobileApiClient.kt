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
    val previewable: Boolean = false,
) {
    fun displayName(): String {
        val genderName = when (gender) {
            "male" -> "男声"
            "female" -> "女声"
            else -> "特色音色"
        }
        return "$name · $genderName"
    }
}

data class ClientExperienceModeOption(
    val id: String,
    val title: String,
    val subtitle: String,
    val engine: String,
    val model: String,
    val defaultVoice: String,
    val voices: List<ClientVoiceOption>,
)

data class ClientCapabilities(
    val previewEnabled: Boolean,
    val defaultVoice: String,
    val defaultExperienceMode: String,
    val voices: List<ClientVoiceOption>,
    val experienceModes: List<ClientExperienceModeOption>,
) {
    fun mode(id: String): ClientExperienceModeOption? = experienceModes.firstOrNull { it.id == id }
}

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
        .readTimeout(25, TimeUnit.SECONDS)
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
                        val voices = parseVoices(json.optJSONArray("voices") ?: JSONArray())
                        val modesJson = json.optJSONArray("experienceModes") ?: JSONArray()
                        val modes = buildList {
                            for (index in 0 until modesJson.length()) {
                                val item = modesJson.optJSONObject(index) ?: continue
                                add(
                                    ClientExperienceModeOption(
                                        id = item.optString("id"),
                                        title = item.optString("title", item.optString("id")),
                                        subtitle = item.optString("subtitle"),
                                        engine = item.optString("engine"),
                                        model = item.optString("model"),
                                        defaultVoice = item.optString("defaultVoice"),
                                        voices = parseVoices(item.optJSONArray("voices") ?: JSONArray()),
                                    ),
                                )
                            }
                        }.ifEmpty { fallbackExperienceModes() }
                        callback(
                            Result.success(
                                ClientCapabilities(
                                    previewEnabled = json.optBoolean("previewEnabled", false),
                                    defaultVoice = json.optJSONObject("defaults")?.optString("outputVoice", "longanqian") ?: "longanqian",
                                    defaultExperienceMode = json.optJSONObject("defaults")?.optString("experienceMode", "native_plus") ?: "native_plus",
                                    voices = voices,
                                    experienceModes = modes,
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

    fun previewVoice(
        token: String,
        model: String,
        voice: String,
        callback: (Result<ByteArray>) -> Unit,
    ) {
        val payload = JSONObject()
            .put("model", model)
            .put("voice", voice)
            .toString()
            .toRequestBody(JSON_MEDIA_TYPE)
        val request = Request.Builder()
            .url("${baseUrl.trimEnd('/')}/v1/mobile/voice-preview")
            .header("Authorization", "Bearer ${token.trim()}")
            .post(payload)
            .build()
        client.newCall(request).enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) = callback(Result.failure(e))

            override fun onResponse(call: Call, response: Response) {
                response.use {
                    if (!it.isSuccessful) {
                        val body = it.body?.string().orEmpty()
                        val message = runCatching { JSONObject(body).optString("message") }.getOrDefault("")
                        callback(Result.failure(IllegalStateException(message.ifBlank { "音色试听失败：HTTP ${it.code}" })))
                        return
                    }
                    val audio = it.body?.bytes()
                    if (audio == null || audio.isEmpty()) {
                        callback(Result.failure(IllegalStateException("音色试听没有返回音频")))
                        return
                    }
                    callback(Result.success(audio))
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
        val modes = JSONArray()
        capabilities.experienceModes.forEach { mode ->
            modes.put(
                JSONObject()
                    .put("id", mode.id)
                    .put("title", mode.title)
                    .put("subtitle", mode.subtitle)
                    .put("engine", mode.engine)
                    .put("model", mode.model)
                    .put("defaultVoice", mode.defaultVoice)
                    .put("voices", voicesToJson(mode.voices)),
            )
        }
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
            .putString("default_voice", capabilities.defaultVoice)
            .putString("default_experience_mode", capabilities.defaultExperienceMode)
            .putString("voices", voicesToJson(capabilities.voices).toString())
            .putString("experience_modes", modes.toString())
            .apply()
    }

    fun loadExperienceModes(context: Context): List<ClientExperienceModeOption> {
        val raw = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString("experience_modes", null)
            ?: return fallbackExperienceModes()
        return runCatching {
            val array = JSONArray(raw)
            buildList {
                for (index in 0 until array.length()) {
                    val item = array.getJSONObject(index)
                    add(
                        ClientExperienceModeOption(
                            id = item.getString("id"),
                            title = item.optString("title", item.getString("id")),
                            subtitle = item.optString("subtitle"),
                            engine = item.optString("engine"),
                            model = item.optString("model"),
                            defaultVoice = item.optString("defaultVoice"),
                            voices = parseVoices(item.optJSONArray("voices") ?: JSONArray()),
                        ),
                    )
                }
            }.ifEmpty { fallbackExperienceModes() }
        }.getOrElse { fallbackExperienceModes() }
    }

    fun loadVoices(context: Context): List<ClientVoiceOption> {
        val raw = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString("voices", null) ?: return fallbackVoices()
        return runCatching { parseVoices(JSONArray(raw)) }.getOrElse { fallbackVoices() }
    }

    private fun voicesToJson(voices: List<ClientVoiceOption>): JSONArray = JSONArray().apply {
        voices.forEach { voice ->
            put(
                JSONObject()
                    .put("id", voice.id)
                    .put("name", voice.name)
                    .put("gender", voice.gender)
                    .put("description", voice.description)
                    .put("previewable", voice.previewable),
            )
        }
    }
}

private fun parseVoices(array: JSONArray): List<ClientVoiceOption> = buildList {
    for (index in 0 until array.length()) {
        val item = array.optJSONObject(index) ?: continue
        add(
            ClientVoiceOption(
                id = item.optString("id"),
                name = item.optString("name", item.optString("id")),
                gender = item.optString("gender", "neutral"),
                description = item.optString("description"),
                previewable = item.optBoolean("previewable", false),
            ),
        )
    }
}

private fun fallbackExperienceModes(): List<ClientExperienceModeOption> = listOf(
    ClientExperienceModeOption(
        id = "economy_live",
        title = "Economy Live",
        subtitle = "低成本实时链路 · 流式 ASR + LLM + 情绪化 TTS",
        engine = "cascaded",
        model = "qwen3-tts-instruct-flash-realtime",
        defaultVoice = "Cherry",
        voices = fallbackVoices(),
    ),
    ClientExperienceModeOption(
        id = "native_flash",
        title = "Native Flash",
        subtitle = "端到端实时语音 · 更低成本、更快响应",
        engine = "omni_realtime",
        model = "qwen-audio-3.0-realtime-flash",
        defaultVoice = "longanqian",
        voices = fallbackNativeVoices(),
    ),
    ClientExperienceModeOption(
        id = "native_plus",
        title = "Native Plus",
        subtitle = "端到端实时语音 · 更强理解与自然表达",
        engine = "omni_realtime",
        model = "qwen-audio-3.0-realtime-plus",
        defaultVoice = "longanqian",
        voices = fallbackNativeVoices(),
    ),
)

private fun fallbackVoices(): List<ClientVoiceOption> = listOf(
    ClientVoiceOption("Cherry", "芊悦", "female", "阳光积极、亲切自然"),
    ClientVoiceOption("Serena", "苏瑶", "female", "温柔自然"),
    ClientVoiceOption("Ethan", "晨煦", "male", "阳光温暖"),
    ClientVoiceOption("Maia", "四月", "female", "知性温柔"),
    ClientVoiceOption("Kai", "凯", "male", "舒缓耐听"),
)

private fun fallbackNativeVoices(): List<ClientVoiceOption> = listOf(
    ClientVoiceOption("longanqian", "龙安千", "neutral", "Qwen-Audio Realtime 默认系统音色", true),
    ClientVoiceOption("longanlingxin", "龙安灵心", "female", "知心温暖，适合长期陪伴式对话", true),
    ClientVoiceOption("longanlingxi", "龙安灵希", "female", "可爱甜美，表达灵动", true),
    ClientVoiceOption("longanxiaoxin", "龙安小昕", "female", "亲切活泼，适合轻松聊天", true),
    ClientVoiceOption("longanlufeng", "龙安鲁风", "neutral", "明亮开朗，表达有活力", true),
)
