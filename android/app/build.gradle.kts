import java.net.URI

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
    id("com.google.devtools.ksp")
}

// This is a public server origin, never an API key or an access token.
val apiBaseUrl = providers.gradleProperty("apiBaseUrl")
    .orElse(providers.environmentVariable("TROPA_API_BASE_URL"))
    .orElse("")
    .get().trimEnd('/')
if (apiBaseUrl.isNotEmpty()) {
    val uri = URI(apiBaseUrl)
    require(uri.scheme == "https" && !uri.host.isNullOrBlank() &&
        uri.userInfo == null && uri.query == null && uri.fragment == null) {
        "apiBaseUrl must be an HTTPS URL without credentials, query, or fragment."
    }
}

android {
    namespace = "ru.tropa.app"
    compileSdk = 36

    defaultConfig {
        applicationId = "ru.tropa.app.preview"
        minSdk = 26
        targetSdk = 36
        versionCode = 13
        versionName = "0.4.25-preview"
        buildConfigField("String", "API_BASE_URL", "\"$apiBaseUrl\"")
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        // Both physical ARM phones and an x86_64 emulator are covered by this APK.
        val requestedAbi = providers.gradleProperty("targetAbi").orNull
        require(requestedAbi == null || requestedAbi in setOf("arm64-v8a", "armeabi-v7a", "x86_64")) { "Unsupported targetAbi" }
        ndk { abiFilters += requestedAbi?.let(::listOf) ?: listOf("arm64-v8a", "armeabi-v7a", "x86_64") }
    }

    buildTypes {
        debug { isDebuggable = true }
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            // The owner supplies a release signing key outside the repository.
            // No generated debug key is silently reused as a production key.
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
    buildFeatures { compose = true; buildConfig = true }
    packaging {
        resources.excludes += setOf("META-INF/AL2.0", "META-INF/LGPL2.1")
        // Smaller direct-download APK. Android extracts the libraries at install;
        // their 64-bit ELF LOAD alignment is checked independently by verify-apk.py.
        jniLibs.useLegacyPackaging = true
    }
    testOptions {
        unitTests.isIncludeAndroidResources = true
        unitTests.all {
            it.systemProperty("tropnik.assets", file("src/main/assets").absolutePath)
            it.inputs.dir(file("src/main/assets"))
            val plannerIndex = rootProject.file("../web/lib/trail-connections.generated.json")
            it.systemProperty("tropnik.planner.index", plannerIndex.absolutePath)
            it.inputs.file(plannerIndex)
        }
    }
}

ksp { arg("room.schemaLocation", "$projectDir/schemas") }

dependencies {
    implementation(platform("androidx.compose:compose-bom:2025.10.01"))
    implementation("androidx.core:core-ktx:1.17.0")
    implementation("androidx.activity:activity-compose:1.11.0")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.9.4")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.9.4")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.9.4")
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.room:room-runtime:2.8.5")
    implementation("androidx.room:room-ktx:2.8.5")
    ksp("androidx.room:room-compiler:2.8.5")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.10.2")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20250517")
    testImplementation("com.squareup.okhttp3:mockwebserver:4.12.0")
    testImplementation("com.squareup.okhttp3:okhttp-tls:4.12.0")
    androidTestImplementation(platform("androidx.compose:compose-bom:2025.10.01"))
    androidTestImplementation("androidx.test.ext:junit:1.3.0")
    androidTestImplementation("androidx.test:runner:1.7.0")
    androidTestImplementation("androidx.compose.ui:ui-test-junit4")
}
