package cn.mv3.aipany

import android.Manifest
import android.app.Activity
import android.app.AlertDialog
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.ProgressDialog
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.Settings
import android.widget.Toast
import androidx.core.app.NotificationCompat
import androidx.core.content.FileProvider
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.NetworkType
import androidx.work.PeriodicWorkRequest
import androidx.work.WorkManager
import androidx.work.Worker
import androidx.work.WorkerParameters
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.security.MessageDigest
import java.util.concurrent.TimeUnit

/** Metadata published next to the signed APK in the android-latest GitHub Release. */
data class AppUpdateInfo(
    val versionCode: Int,
    val versionName: String,
    val downloadUrl: String,
    val sha256: String,
    val releaseNotes: String,
    val mandatory: Boolean,
    val publishedAt: String,
) {
    fun isNewerThanCurrent(): Boolean = versionCode > BuildConfig.VERSION_CODE
}

object AppUpdateJson {
    fun parse(raw: String): AppUpdateInfo {
        val json = JSONObject(raw)
        val versionCode = json.getInt("versionCode")
        val versionName = json.getString("versionName").trim()
        val downloadUrl = json.getString("downloadUrl").trim()
        val sha256 = json.getString("sha256").trim().lowercase()
        require(versionCode > 0) { "更新版本号无效" }
        require(versionName.isNotBlank()) { "更新版本名称为空" }
        require(downloadUrl.startsWith("https://")) { "更新下载地址必须使用 HTTPS" }
        require(sha256.matches(Regex("[0-9a-f]{64}"))) { "更新校验值无效" }
        return AppUpdateInfo(
            versionCode = versionCode,
            versionName = versionName,
            downloadUrl = downloadUrl,
            sha256 = sha256,
            releaseNotes = json.optString("releaseNotes", "稳定性与体验优化").trim(),
            mandatory = json.optBoolean("mandatory", false),
            publishedAt = json.optString("publishedAt", "").trim(),
        )
    }
}

object AppUpdateManager {
    private const val PREFS = "aipany_app_updates"
    private const val KEY_AUTO_CHECK = "auto_check"
    private const val KEY_LAST_CHECK_AT = "last_check_at"
    private const val KEY_LAST_PROMPTED_VERSION = "last_prompted_version"
    private const val KEY_LAST_NOTIFIED_VERSION = "last_notified_version"
    private const val KEY_PENDING_APK = "pending_apk"
    private const val CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000L
    private const val WORK_NAME = "aipany-periodic-update-check"
    private const val CHANNEL_ID = "aipany_app_updates"
    private const val NOTIFICATION_ID = 4104
    private const val NOTIFICATION_PERMISSION_REQUEST = 4105

    private val http = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(60, TimeUnit.SECONDS)
        .followRedirects(true)
        .retryOnConnectionFailure(true)
        .build()

    fun initialize(activity: Activity) {
        createNotificationChannel(activity)
        schedulePeriodicCheck(activity)
        requestNotificationPermission(activity)
        resumePendingInstall(activity)
        if (isAutoCheckEnabled(activity) && shouldCheckNow(activity)) {
            checkForUpdate(activity, interactive = false)
        }
    }

    fun isAutoCheckEnabled(context: Context): Boolean = prefs(context).getBoolean(KEY_AUTO_CHECK, true)

    fun setAutoCheckEnabled(context: Context, enabled: Boolean) {
        prefs(context).edit().putBoolean(KEY_AUTO_CHECK, enabled).apply()
        if (enabled) schedulePeriodicCheck(context) else WorkManager.getInstance(context).cancelUniqueWork(WORK_NAME)
    }

    fun checkForUpdate(activity: Activity, interactive: Boolean) {
        if (interactive) Toast.makeText(activity, "正在检查新版本…", Toast.LENGTH_SHORT).show()
        Thread {
            runCatching { fetchUpdateInfo() }
                .onSuccess { info ->
                    prefs(activity).edit().putLong(KEY_LAST_CHECK_AT, System.currentTimeMillis()).apply()
                    activity.runOnUiThread {
                        if (activity.isFinishing || activity.isDestroyed) return@runOnUiThread
                        if (!info.isNewerThanCurrent()) {
                            if (interactive) Toast.makeText(activity, "当前已是最新版本 ${BuildConfig.VERSION_NAME}", Toast.LENGTH_LONG).show()
                            return@runOnUiThread
                        }
                        notifyUpdateAvailable(activity, info)
                        val prompted = prefs(activity).getInt(KEY_LAST_PROMPTED_VERSION, 0)
                        if (interactive || prompted != info.versionCode) {
                            prefs(activity).edit().putInt(KEY_LAST_PROMPTED_VERSION, info.versionCode).apply()
                            showUpdateDialog(activity, info)
                        }
                    }
                }
                .onFailure { error ->
                    if (interactive) {
                        activity.runOnUiThread {
                            Toast.makeText(activity, "检查更新失败：${friendlyError(error)}", Toast.LENGTH_LONG).show()
                        }
                    }
                }
        }.start()
    }

    fun resumePendingInstall(activity: Activity) {
        val path = prefs(activity).getString(KEY_PENDING_APK, null) ?: return
        val apk = File(path)
        if (!apk.isFile) {
            prefs(activity).edit().remove(KEY_PENDING_APK).apply()
            return
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && !activity.packageManager.canRequestPackageInstalls()) return
        prefs(activity).edit().remove(KEY_PENDING_APK).apply()
        launchInstaller(activity, apk)
    }

    internal fun fetchUpdateInfo(): AppUpdateInfo {
        val separator = if (BuildConfig.UPDATE_MANIFEST_URL.contains('?')) '&' else '?'
        val request = Request.Builder()
            .url("${BuildConfig.UPDATE_MANIFEST_URL}${separator}t=${System.currentTimeMillis()}")
            .header("Accept", "application/json")
            .header("User-Agent", "Aipany-Android/${BuildConfig.VERSION_NAME}")
            .get()
            .build()
        http.newCall(request).execute().use { response ->
            if (!response.isSuccessful) throw IllegalStateException("更新服务 HTTP ${response.code}")
            val body = response.body?.string().orEmpty()
            if (body.isBlank()) throw IllegalStateException("更新服务返回空内容")
            return AppUpdateJson.parse(body)
        }
    }

    internal fun notifyUpdateAvailable(context: Context, info: AppUpdateInfo) {
        createNotificationChannel(context)
        val prefs = prefs(context)
        if (prefs.getInt(KEY_LAST_NOTIFIED_VERSION, 0) == info.versionCode) return
        val intent = Intent(context, MainActivity::class.java)
            .putExtra("open_update", true)
            .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        val pendingIntent = PendingIntent.getActivity(
            context,
            info.versionCode,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val notification = NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.stat_sys_download_done)
            .setContentTitle("Aipany ${info.versionName} 可更新")
            .setContentText(info.releaseNotes.ifBlank { "点击下载并安装新版本" })
            .setStyle(NotificationCompat.BigTextStyle().bigText(info.releaseNotes.ifBlank { "点击下载并安装新版本" }))
            .setContentIntent(pendingIntent)
            .setAutoCancel(true)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .build()
        val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        runCatching { manager.notify(NOTIFICATION_ID, notification) }
        prefs.edit().putInt(KEY_LAST_NOTIFIED_VERSION, info.versionCode).apply()
    }

    private fun showUpdateDialog(activity: Activity, info: AppUpdateInfo) {
        val message = buildString {
            append("当前版本：${BuildConfig.VERSION_NAME}\n")
            append("最新版本：${info.versionName}\n")
            if (info.publishedAt.isNotBlank()) append("发布时间：${info.publishedAt}\n")
            append("\n")
            append(info.releaseNotes.ifBlank { "稳定性与体验优化" })
            append("\n\n下载完成后，Android 系统会要求你确认安装。")
        }
        val builder = AlertDialog.Builder(activity)
            .setTitle("发现 Aipany 新版本")
            .setMessage(message)
            .setPositiveButton("下载更新") { _, _ -> downloadAndInstall(activity, info) }
        if (!info.mandatory) builder.setNegativeButton("稍后", null)
        builder.setCancelable(!info.mandatory).show()
    }

    @Suppress("DEPRECATION")
    private fun downloadAndInstall(activity: Activity, info: AppUpdateInfo) {
        val progress = ProgressDialog(activity).apply {
            setTitle("正在下载 ${info.versionName}")
            setMessage("准备下载…")
            setProgressStyle(ProgressDialog.STYLE_HORIZONTAL)
            max = 100
            setCancelable(false)
            show()
        }
        Thread {
            runCatching {
                val directory = File(activity.externalCacheDir ?: activity.cacheDir, "updates").apply { mkdirs() }
                val target = File(directory, "Aipany-${info.versionName}.apk")
                val request = Request.Builder()
                    .url(info.downloadUrl)
                    .header("User-Agent", "Aipany-Android/${BuildConfig.VERSION_NAME}")
                    .get()
                    .build()
                http.newCall(request).execute().use { response ->
                    if (!response.isSuccessful) throw IllegalStateException("下载失败 HTTP ${response.code}")
                    val body = response.body ?: throw IllegalStateException("下载内容为空")
                    val total = body.contentLength().coerceAtLeast(1L)
                    body.byteStream().use { input ->
                        FileOutputStream(target).use { output ->
                            val buffer = ByteArray(32 * 1024)
                            var downloaded = 0L
                            while (true) {
                                val read = input.read(buffer)
                                if (read < 0) break
                                output.write(buffer, 0, read)
                                downloaded += read
                                val percent = ((downloaded * 100) / total).toInt().coerceIn(0, 100)
                                activity.runOnUiThread {
                                    progress.progress = percent
                                    progress.setMessage("已下载 $percent%")
                                }
                            }
                        }
                    }
                }
                val actual = sha256(target)
                if (!actual.equals(info.sha256, ignoreCase = true)) {
                    target.delete()
                    throw IllegalStateException("APK 完整性校验失败")
                }
                target
            }.onSuccess { apk ->
                activity.runOnUiThread {
                    progress.dismiss()
                    requestInstallPermissionOrInstall(activity, apk)
                }
            }.onFailure { error ->
                activity.runOnUiThread {
                    progress.dismiss()
                    Toast.makeText(activity, "更新下载失败：${friendlyError(error)}", Toast.LENGTH_LONG).show()
                }
            }
        }.start()
    }

    private fun requestInstallPermissionOrInstall(activity: Activity, apk: File) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && !activity.packageManager.canRequestPackageInstalls()) {
            prefs(activity).edit().putString(KEY_PENDING_APK, apk.absolutePath).apply()
            Toast.makeText(activity, "请允许 Aipany 安装应用，返回后会继续安装", Toast.LENGTH_LONG).show()
            activity.startActivity(
                Intent(
                    Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                    Uri.parse("package:${activity.packageName}"),
                ),
            )
            return
        }
        launchInstaller(activity, apk)
    }

    private fun launchInstaller(activity: Activity, apk: File) {
        val uri = FileProvider.getUriForFile(activity, "${activity.packageName}.fileprovider", apk)
        val intent = Intent(Intent.ACTION_VIEW)
            .setDataAndType(uri, "application/vnd.android.package-archive")
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
        runCatching { activity.startActivity(intent) }
            .onFailure { Toast.makeText(activity, "无法打开系统安装器：${friendlyError(it)}", Toast.LENGTH_LONG).show() }
    }

    private fun schedulePeriodicCheck(context: Context) {
        if (!isAutoCheckEnabled(context)) return
        val constraints = Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()
        val work = PeriodicWorkRequest.Builder(AppUpdateWorker::class.java, 12, TimeUnit.HOURS)
            .setConstraints(constraints)
            .build()
        WorkManager.getInstance(context).enqueueUniquePeriodicWork(
            WORK_NAME,
            ExistingPeriodicWorkPolicy.UPDATE,
            work,
        )
    }

    private fun requestNotificationPermission(activity: Activity) {
        if (Build.VERSION.SDK_INT >= 33 &&
            activity.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            activity.requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), NOTIFICATION_PERMISSION_REQUEST)
        }
    }

    private fun shouldCheckNow(context: Context): Boolean {
        val last = prefs(context).getLong(KEY_LAST_CHECK_AT, 0L)
        return System.currentTimeMillis() - last >= CHECK_INTERVAL_MS
    }

    private fun createNotificationChannel(context: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        manager.createNotificationChannel(
            NotificationChannel(
                CHANNEL_ID,
                "Aipany 版本更新",
                NotificationManager.IMPORTANCE_HIGH,
            ).apply { description = "新版本发布与下载安装提醒" },
        )
    }

    private fun prefs(context: Context) = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    private fun sha256(file: File): String {
        val digest = MessageDigest.getInstance("SHA-256")
        file.inputStream().use { input ->
            val buffer = ByteArray(32 * 1024)
            while (true) {
                val read = input.read(buffer)
                if (read < 0) break
                digest.update(buffer, 0, read)
            }
        }
        return digest.digest().joinToString("") { "%02x".format(it) }
    }

    private fun friendlyError(error: Throwable): String = error.message?.take(180) ?: error.javaClass.simpleName
}

class AppUpdateWorker(
    appContext: Context,
    params: WorkerParameters,
) : Worker(appContext, params) {
    override fun doWork(): Result {
        if (!AppUpdateManager.isAutoCheckEnabled(applicationContext)) return Result.success()
        return runCatching {
            val info = AppUpdateManager.fetchUpdateInfo()
            if (info.isNewerThanCurrent()) AppUpdateManager.notifyUpdateAvailable(applicationContext, info)
            Result.success()
        }.getOrElse { Result.retry() }
    }
}
