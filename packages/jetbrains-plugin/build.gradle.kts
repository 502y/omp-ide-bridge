plugins {
    kotlin("jvm") version "1.9.25"
    id("org.jetbrains.intellij.platform") version "2.2.1"
}

group = "community.omp.idebridge"
version = "0.1.0"

repositories {
    mavenCentral()
    intellijPlatform {
        defaultRepositories()
    }
}

dependencies {
    intellijPlatform {
        create(providers.gradleProperty("platformType").get(), providers.gradleProperty("platformVersion").get())
    }
    // WebSocket server used by IdeBridgeServer (IDE is the WS server per docs/protocol.md).
    implementation("org.java-websocket:Java-WebSocket:1.5.7")
}

intellijPlatform {
    pluginConfiguration {
        id = "community.omp.idebridge"
        name = "OMP IDE Bridge (Community)"
        version = project.version.toString()
        ideaVersion {
            // User runs IDEs from 2023.1 (231) up to 2026.2 (262) and beyond.
            sinceBuild = "231"
            // NOTE: plugin 2.x always patches an until-build (default "<sdk>.*");
            // "" yields invalid until-build="". The attribute is stripped after
            // patching below => truly open-ended upper bound.
        }
    }
    pluginVerification {
        ides {
            // Compile SDK (cached) + the declared floor (2023.1) to prove
            // since-build 231 — ProjectActivity must exist there.
            ide(providers.gradleProperty("platformType").get(), providers.gradleProperty("platformVersion").get())
            ide("IC", "2023.1.7")
        }
    }
}

// Strip the auto-patched until-build so the plugin stays installable on future
// IDEs (2026.2+ today). Without this, 2.x writes until-build="<compile-sdk>.*".
tasks.named("patchPluginXml") {
    doLast {
        val patched = layout.buildDirectory.file("tmp/patchPluginXml/plugin.xml").get().asFile
        patched.writeText(patched.readText().replace(Regex("\n?\\s*until-build=\"[^\"]*\""), ""))
    }
}

kotlin {
    jvmToolchain(17)
}
