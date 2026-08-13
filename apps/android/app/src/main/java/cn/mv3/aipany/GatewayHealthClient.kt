package cn.mv3.aipany

import okhttp3.Call
import okhttp3.Callback
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import org.json.JSONObject
import java.io.IOException
import java.util.concurrent.TimeUnit

data class GatewayHealthSnapshot(
    val ok: Boolean,
    val service: String,
    val version: String,
    val realtimeEngine: String,
    val nativeLiveAvailable: Boolean,
    val authMode: String,
)

class GatewayHealthClient(
    private val baseUrl: String = MobileApiClient.BASE_URL,
) {
    private val client = OkHttpClient.Builder()
        .connectTimeout(8, TimeUnit.SECONDS)
        .readTimeout(12, TimeUnit.SECONDS)
        .retryOnConnectionFailure(true)
        .build()

    fun fetch(callback: (Result<GatewayHealthSnapshot>) -> Unit) {
        val request = Request.Builder()
            .url("${baseUrl.trimEnd('/')}/health")
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
                    runCatching {
                        val json = JSONObject(body)
                        GatewayHealthSnapshot(
                            ok = json.optBoolean("ok", false),
                            service = json.optString("service", "aipany-realtime-gateway"),
                            version = json.optString("version", "unknown"),
                            realtimeEngine = json.optString("realtimeEngine", "unknown"),
                            nativeLiveAvailable = json.optBoolean("nativeLiveAvailable", false),
                            authMode = json.optString("auth", "unknown"),
                        )
                    }.fold(
                        onSuccess = { callback(Result.success(it)) },
                        onFailure = { callback(Result.failure(it)) },
                    )
                }
            }
        })
    }

    fun close() {
        client.dispatcher.executorService.shutdown()
        client.connectionPool.evictAll()
    }
}
