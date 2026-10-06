package ai.neuralnomads.codenomad.recovery

// Standalone JVM tests of the production class: no Android SDK, mocks, or
// replicated policy. Compile both files with kotlinc and run this main.
fun main() {
    val root = "https://one.example/"
    val authority = ConnectionAuthority()
    val first = authority.snapshot()
    val duplicate = authority.snapshot()
    check(first == duplicate) // Readiness never rotates/selects authority.
    check(!authority.admits(root))
    for (invalid in listOf("http://one.example/", "https://user@one.example/", "https://one.example/path",
                           "https://one.example/?token=secret", "https://tauri.localhost/")) {
        check(!authority.commit(first, invalid))
        check(authority.snapshot() == first)
    }
    check(authority.commit(first, root))
    check(!authority.commit(duplicate, "https://two.example/"))
    check(authority.admits(root))
    check(!authority.admits("https://two.example/"))

    // Regression: block the INITIAL POST, before its 307/308 response can send
    // preserved credentials/body to a different origin. No initial request is
    // admitted, so neither the initial server nor redirect target is reached.
    for (status in listOf(307, 308)) {
        var initialRequests = 0
        var redirectedRequests = 0
        if (authority.interceptRequest("${root}redirect-$status", "POST", true)) {
            initialRequests++
            // Android may follow this without re-running interception.
            redirectedRequests++
        }
        check(initialRequests == 0 && redirectedRequests == 0) { "Unsafe $status POST chain" }
    }
    for (method in listOf("POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS", "get")) {
        check(!authority.allowsRequest(root, method, true))
        check(!authority.allowsRequest(ConnectionAuthority.LAUNCHER, method, true))
    }
    check(authority.allowsRequest("${root}api/auth/login", "POST", false)) // fetch login unaffected.
    check(authority.allowsRequest(root, "GET", true)) // location.replace('/') after login.
    check(!authority.allowsRequest("https://evil.example/", "GET", true))
    check(!authority.admits("https://user@one.example/"))
    check(!authority.admits("http://one.example/"))
    check(!authority.admits("https://one.example:8443/"))

    authority.disconnect()
    val beforeReturn = authority.snapshot()
    authority.disconnect() // Native return before Rust navigation notification.
    check(!authority.commit(beforeReturn, root))
    val beforeReplacement = authority.snapshot()
    authority.documentStarted(ConnectionAuthority.LAUNCHER) // Same-URL reload.
    check(!authority.commit(beforeReplacement, root))
    check(!authority.canConnect())
    authority.documentFinished(ConnectionAuthority.LAUNCHER)
    check(authority.canConnect())
    check(!ConnectionAuthority().commit(authority.snapshot(), root)) // Different WebView identity.

    val beforeRequest = authority.snapshot()
    check(authority.interceptRequest(ConnectionAuthority.LAUNCHER, "GET", true))
    check(!authority.commit(beforeRequest, root)) // Background request, before UI onPageStarted.
    check(!authority.canConnect())
    authority.documentFinished("https://old-document.example/")
    check(!authority.canConnect()) // Late page-finished cannot settle a different document.
    authority.documentFinished(ConnectionAuthority.LAUNCHER)

    val beforeRejectedPost = authority.snapshot()
    check(!authority.interceptRequest(ConnectionAuthority.LAUNCHER, "POST", true))
    check(authority.snapshot() == beforeRejectedPost) // Denial does not select/rotate.

    val afterReturn = authority.snapshot()
    check(authority.commit(afterReturn, "https://two.example/"))
    check(!authority.commit(beforeReturn, root)) // Delayed earlier native commit.
    check(authority.admits("https://two.example/"))
    check(!authority.admits(root))
    authority.disconnect() // Renderer death uses the same revocation.
    check(!authority.admits("https://two.example/"))
    check(!authority.commit(afterReturn, root))
    println("ConnectionAuthority: readiness, concurrent selection, return/replacement, renderer revocation, and 307/308 non-GET regression checks passed")
}
