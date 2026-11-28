// The APK of the native Android client. scripts/rune/bundle-android.mjs passes Rune's Kotlin host
// from the locked Rune checkout, the compiled application library and the output directory.
plugins {
    id("com.android.application") version "9.5.3"
}

val runeKotlin = providers.gradleProperty("runeKotlin").get()
val appLibraries = providers.gradleProperty("appLibraries").get()

layout.buildDirectory = file(providers.gradleProperty("output").get())

android {
    namespace = "ai.neuralnomads.codenomad.rune"
    compileSdk = 36

    defaultConfig {
        applicationId = "ai.neuralnomads.codenomad.rune"
        minSdk = 26
        targetSdk = 36
        versionCode = 1
        versionName = "0.1.0"
    }

    sourceSets.getByName("main") {
        kotlin.directories.add(runeKotlin)
        jniLibs.directories.add(appLibraries)
    }
}
