package cn.mv3.aipany

import android.content.Context
import android.provider.Settings
import okhttp3.Call
import okhttp3.Callback
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import org.json.JSONObject
import java.io.IOException
import java.util.concurrent.TimeUnit

class ClientDiagnosticUploadClient(
    private val baseUrl: String = MobileApiClient.BASE_URL,
) {
    private val client = OkHttpClient.Builder()
        .connectTimeout(12, TimeUnit.SECONDS)
        .readTimeout(25, TimeUnit.SECONDS)
        .retryOnConnectionFailure(true)
        .build()

    fun upload(
        context: Context,
        report: JSONObject,
        callback: (Result<String>) -> Unit,
    ) {
        val deviceId = Settings.Secure.getString(context.contentResolver, Settings.Secure.ANDROID_ID)
            ?.takeIf { it.length >= 8 }
            ?: "android-diagnostics-${System.currentTimeMillis()}"
        bootstrap(deviceId) { bootstrapResult ->
            bootstrapResult.fold(
                onSuccess = { token -> uploadWithToken(token, report, callback) },
                onFailure = { callback(Result.failure(it)) },
            )
        }
    }

    fun close() {
        client.dispatcher.executorService.shutdown()
        client.connectionPool.evictAll()
    }

    private fun bootstrap(deviceId: String, callback: (Result<String>) -> Unit) {
        val payload = JSONObject()
            .put("deviceId", deviceId)
            .put("platform", "android")
            .put("appVersion", BuildConfig.VERSION_NAME)
            .toString()
            .toRequestBody(JSON_MEDIA_TYPE)
        val request = Request.Builder()
            .url("${baseUrl.trimEnd('/')}/v1/mobile/bootstrap")
            .post(payload)
            .build()
        client.newCall(request).enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) = callback(Result.failure(e))

            override fun onResponse(call: Call, response: Response) {
                response.use {
                    val body = it.body?.string().orEmpty()
                    if (!it.isSuccessful) {
                        callback(Result.failure(IllegalStateException("诊断上传鉴权失败：HTTP ${it.code}")))
                        return
                    }
                    runCatching { JSONObject(body).getString("token") }
                        .fold(
                            onSuccess = { token -> callback(Result.success(token)) },
                            onFailure = { error -> callback(Result.failure(error)) },
                        )
                }
            }
        })
    }

    private fun uploadWithToken(
        token: String,
        report: JSONObject,
        callback: (Result<String>) -> Unit,
    ) {
        val request = Request.Builder()
            .url("${baseUrl.trimEnd('/')}/v1/mobile/diagnostics")
            .header("Authorization", "Bearer $token")
            .post(report.toString().toRequestBody(JSON_MEDIA_TYPE))
            .build()
        client.newCall(request).enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) = callback(Result.failure(e))

            override fun onResponse(call: Call, response: Response) {
                response.use {
                    val body = it.body?.string().orEmpty()
                    if (!it.isSuccessful) {
                        callback(Result.failure(IllegalStateException("诊断报告上传失败：HTTP ${it.code}")))
                        return
                    }
                    runCatching { JSONObject(body).optString("id") }
                        .fold(
                            onSuccess = { id -> callback(Result.success(id)) },
                            onFailure = { error -> callback(Result.failure(error)) },
                        )
                }
            }
        })
    }

    companion object {
        private val JSON_MEDIA_TYPE = "application/json; charset=utf-8".toMediaType()
    }
}
