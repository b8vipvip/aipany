plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

val versionCodeOverride = providers.gradleProperty("AIPANY_VERSION_CODE").orNull?.toIntOrNull()
val versionNameOverride = providers.gradleProperty("AIPANY_VERSION_NAME").orNull
val releaseKeystorePath = providers.gradleProperty("AIPANY_KEYSTORE_PATH").orNull ?: System.getenv("AIPANY_KEYSTORE_PATH")
val releaseKeystorePassword = providers.gradleProperty("AIPANY_KEYSTORE_PASSWORD").orNull ?: System.getenv("AIPANY_KEYSTORE_PASSWORD")
val releaseKeyAlias = providers.gradleProperty("AIPANY_KEY_ALIAS").orNull ?: System.getenv("AIPANY_KEY_ALIAS")
val releaseKeyPassword = providers.gradleProperty("AIPANY_KEY_PASSWORD").orNull ?: System.getenv("AIPANY_KEY_PASSWORD")
val releaseSigningConfigured = listOf(
    releaseKeystorePath,
    releaseKeystorePassword,
    releaseKeyAlias,
    releaseKeyPassword,
).all { !it.isNullOrBlank() }

android {
    namespace = "cn.mv3.aipany"
    compileSdk = 35

    defaultConfig {
        applicationId = "cn.mv3.aipany"
        minSdk = 26
        targetSdk = 35
        versionCode = versionCodeOverride ?: 4
        versionName = versionNameOverride ?: "0.4.0"

        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        buildConfigField(
            "String",
            "UPDATE_MANIFEST_URL",
            "\"https://github.com/b8vipvip/aipany/releases/download/android-latest/update.json\"",
        )
    }

    buildFeatures {
        buildConfig = true
    }

    signingConfigs {
        if (releaseSigningConfigured) {
            create("release") {
                storeFile = file(requireNotNull(releaseKeystorePath))
                storePassword = releaseKeystorePassword
                keyAlias = releaseKeyAlias
                keyPassword = releaseKeyPassword
            }
        }
    }

    buildTypes {
        debug {
            applicationIdSuffix = ".dev"
            versionNameSuffix = "-dev"
        }
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.findByName("release")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("androidx.core:core:1.15.0")
    implementation("androidx.work:work-runtime:2.10.0")
    testImplementation("junit:junit:4.13.2")
}
