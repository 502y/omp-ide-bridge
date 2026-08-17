package com.omp.idebridge

import com.google.gson.JsonArray
import com.google.gson.JsonElement
import com.google.gson.JsonObject
import com.intellij.openapi.Disposable
import com.intellij.openapi.application.ApplicationInfo
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.application.ApplicationNamesInfo
import com.intellij.openapi.application.ModalityState
import com.intellij.openapi.components.Service
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.project.Project
import com.intellij.openapi.project.ProjectManager
import com.intellij.openapi.util.SystemInfo
import org.java_websocket.WebSocket
import org.java_websocket.drafts.Draft
import org.java_websocket.exceptions.InvalidDataException
import org.java_websocket.handshake.ClientHandshake
import org.java_websocket.handshake.ServerHandshakeBuilder
import org.java_websocket.server.WebSocketServer
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.nio.charset.StandardCharsets
import java.util.concurrent.atomic.AtomicReference
import java.nio.file.FileAlreadyExistsException
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.Paths
import java.nio.file.attribute.PosixFilePermissions
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CountDownLatch
import java.util.concurrent.ThreadLocalRandom
import java.util.concurrent.TimeUnit

/**
 * Application-level service owning the single WebSocket server for this IDE instance.
 *
 * Implements the server side of docs/protocol.md v1:
 * - binds 127.0.0.1 only, random port in [10000, 65535], up to 20 attempts;
 * - writes ~/.omp/ide/<port>.lock (0600, dir 0700) once listening, deletes it on dispose;
 * - requires the `x-omp-ide-authorization` upgrade header, rejects with close code 1008;
 * - supports multiple simultaneous client connections;
 * - JSON-RPC dispatch is confined: all IntelliJ Platform state is touched on the EDT
 *   (WS worker threads block in invokeAndWait), results are sent back on the WS thread.
 *
 * Capabilities advertised: openDiff=false, diagnostics=true, executeCode=false —
 * `openDiff` returns -32601 (METHOD_NOT_FOUND). Diagnostics are passive daemon
 * highlights (DaemonCodeAnalyzerEx.processHighlights), see ProjectAdapter.
 *
 * Registered as a light service (@Service); it MUST NOT also be declared in plugin.xml.
 */
@Service(Service.Level.APP)
class IdeBridgeServer : Disposable {

    private val log = Logger.getInstance(IdeBridgeServer::class.java)

    private val authToken: String = UUID.randomUUID().toString()
    private val startLock = Any()
    private var server: BridgeWebSocketServer? = null
    private var lockfilePath: Path? = null

    /** Native absolute paths of open projects' basePaths (lockfile format, protocol.md §1). */
    @Volatile
    private var workspaceFolders: List<String> = emptyList()

    /** Project that most recently produced an editor/selection event; drives isActive. */
    @Volatile
    private var lastActiveProject: Project? = null

    /** Last non-empty selection across all projects; survives focus loss (getLatestSelection). */
    @Volatile
    private var latestSelection: CachedSelection? = null

    private data class CachedSelection(val project: Project, val selection: Selection)

    companion object {
        private const val AUTH_HEADER = "x-omp-ide-authorization"
        /** WebSocket close code 1008 (policy violation) for auth failures, per protocol.md §2. */
        private const val CLOSE_POLICY_VIOLATION = 1008
        private const val MIN_PORT = 10_000
        private const val MAX_PORT = 65_535
        private const val MAX_BIND_ATTEMPTS = 20
        private const val MAX_MESSAGE_BYTES = 16 * 1024 * 1024
        private const val CLOSE_MESSAGE_TOO_BIG = 1009

        fun getInstance(): IdeBridgeServer =
            ApplicationManager.getApplication().getService(IdeBridgeServer::class.java)
    }

    // ---------------------------------------------------------------- lifecycle

    /** Idempotent: starts the WS server and writes the lockfile on first success. */
    fun ensureStarted() {
        synchronized(startLock) {
            if (server != null) return
            repeat(MAX_BIND_ATTEMPTS) {
                val port = ThreadLocalRandom.current().nextInt(MIN_PORT, MAX_PORT + 1)
                val candidate = BridgeWebSocketServer(port)
                if (tryStart(candidate)) {
                    server = candidate
                    val lock = lockDir().resolve("$port.lock")
                    lockfilePath = lock
                    writeLockfile()
                    log.info("OMP IDE Bridge listening on 127.0.0.1:$port (lockfile $lock)")
                    return
                }
            }
            log.warn("OMP IDE Bridge: could not bind a port in [$MIN_PORT,$MAX_PORT] after $MAX_BIND_ATTEMPTS attempts")
        }
    }

    private fun tryStart(candidate: BridgeWebSocketServer): Boolean {
        if (!portAvailable(candidate.bindPort)) return false
        return try {
            candidate.start() // returns once the selector thread has started (or failed)
            candidate.awaitStarted()
        } catch (e: Exception) {
            log.info("OMP IDE Bridge: failed to bind port ${candidate.bindPort}: ${e.message}")
            false
        } finally {
            if (!candidate.isRunning) {
                try {
                    candidate.stop(1000)
                } catch (e: Exception) {
                    // never bound — nothing to stop
                }
            }
        }
    }

    private fun portAvailable(port: Int): Boolean = try {
        ServerSocket().use { it.bind(InetSocketAddress("127.0.0.1", port)) }
        true
    } catch (e: Exception) {
        false
    }

    override fun dispose() {
        val s: BridgeWebSocketServer?
        synchronized(startLock) {
            s = server
            server = null
        }
        if (s != null) {
            try {
                sendToAll(s, JsonRpc.notification("shutdown", JsonObject()))
            } catch (e: Exception) {
                // best effort
            }
            try {
                s.stop(2000)
            } catch (e: InterruptedException) {
                Thread.currentThread().interrupt()
            } catch (e: Exception) {
                // already gone
            }
        }
        lockfilePath?.let { p ->
            try {
                Files.deleteIfExists(p)
            } catch (e: Exception) {
                log.warn("OMP IDE Bridge: failed to delete lockfile $p", e)
            }
        }
    }

    // ---------------------------------------------------------------- websocket server

    private inner class BridgeWebSocketServer(val bindPort: Int) :
        WebSocketServer(InetSocketAddress("127.0.0.1", bindPort)) {

        val clients: MutableSet<WebSocket> = ConcurrentHashMap.newKeySet<WebSocket>()
        private val startLatch = CountDownLatch(1)

        @Volatile
        private var startFailure: Throwable? = null

        @Volatile
        var isRunning: Boolean = false
            private set

        override fun onWebsocketHandshakeReceivedAsServer(
            conn: WebSocket,
            draft: Draft,
            request: ClientHandshake,
        ): ServerHandshakeBuilder {
            val token = request.getFieldValue(AUTH_HEADER)
            if (token != authToken) {
                log.info("OMP IDE Bridge: rejected handshake (bad $AUTH_HEADER) from ${conn.remoteSocketAddress}")
                // Throwing InvalidDataException during the handshake makes Java-WebSocket
                // close the connection with the exception's close code (1008 here).
                throw InvalidDataException(CLOSE_POLICY_VIOLATION, "Unauthorized")
            }
            return super.onWebsocketHandshakeReceivedAsServer(conn, draft, request)
        }

        override fun onOpen(conn: WebSocket, handshake: ClientHandshake) {
            clients.add(conn)
            log.info("OMP IDE Bridge: client connected from ${conn.remoteSocketAddress} (${clients.size} total)")
        }

        override fun onClose(conn: WebSocket, code: Int, reason: String, remote: Boolean) {
            clients.remove(conn)
        }

        override fun onMessage(conn: WebSocket, message: String) {
            if (message.toByteArray(StandardCharsets.UTF_8).size > MAX_MESSAGE_BYTES) {
                conn.close(CLOSE_MESSAGE_TOO_BIG, "Message too large")
                return
            }
            handleMessage(conn, message)
        }

        override fun onError(conn: WebSocket?, ex: Exception) {
            if (!isRunning && conn == null) {
                // startup (bind) failure
                startFailure = ex
                startLatch.countDown()
            }
            log.warn("OMP IDE Bridge: websocket error: ${ex.message}")
        }

        override fun onStart() {
            isRunning = true
            startLatch.countDown()
        }

        fun awaitStarted(): Boolean {
            try {
                startLatch.await(10, TimeUnit.SECONDS)
            } catch (e: InterruptedException) {
                Thread.currentThread().interrupt()
                return false
            }
            return isRunning && startFailure == null
        }
    }

    // ---------------------------------------------------------------- JSON-RPC dispatch

    private fun handleMessage(conn: WebSocket, text: String) {
        val obj = try {
            JsonRpc.parse(text)
        } catch (e: RpcException) {
            conn.send(JsonRpc.error(null, e.code, e.message ?: "error"))
            return
        }
        val id = obj.get("id")
        val methodEl = obj.get("method")
        if (methodEl == null || !methodEl.isJsonPrimitive || !methodEl.asJsonPrimitive.isString) {
            conn.send(JsonRpc.error(id, ErrorCodes.INVALID_REQUEST, "Missing or invalid 'method'"))
            return
        }
        val method = methodEl.asString
        if (id == null || id.isJsonNull) {
            handleClientNotification(method)
            return
        }
        val params = obj.get("params")?.takeIf { it.isJsonObject }?.asJsonObject
        val response = try {
            JsonRpc.result(id, dispatch(method, params))
        } catch (e: RpcException) {
            JsonRpc.error(id, e.code, e.message ?: "RPC error")
        } catch (e: Throwable) {
            log.warn("OMP IDE Bridge: internal error handling '$method'", e)
            JsonRpc.error(id, ErrorCodes.INTERNAL_ERROR, "Internal error")
        }
        conn.send(response)
    }

    private fun handleClientNotification(@Suppress("UNUSED_PARAMETER") method: String) {
        // The only inbound notification in protocol v1 is `shutdown` (peer going away);
        // the socket close that follows is handled by onClose. Unknown notifications
        // are ignored per JSON-RPC.
    }

    private fun dispatch(method: String, params: JsonObject?): JsonElement = when (method) {
        "initialize" -> handleInitialize()

        "getWorkspaceFolders" -> handleGetWorkspaceFolders()

        "getOpenEditors" -> JsonObject().apply {
            add("editors", JsonRpc.toJsonTree(onEdt { collectEditors() }))
        }

        "getCurrentSelection" -> selectionResult(
            onEdt { activeOrFirstProject()?.let { ProjectAdapter.getInstance(it).currentSelection() } }
        )

        "getLatestSelection" -> selectionResult(latestNonEmptySelection())

        "openFile" -> {
            val uri = params.requireString("uri")
            val line = params.optNonNegativeInt("line")
            val character = params.optNonNegativeInt("character")
            // `preview` has no JetBrains equivalent; accepted and ignored.
            val opened = onEdt {
                val path = uriToPath(uri)
                val project = projectForPath(path)
                    ?: throw RpcException.invalidParams("No open project contains $uri")
                ProjectAdapter.getInstance(project).openFile(path, line, character)
            }
            JsonObject().apply { addProperty("opened", opened) }
        }

        "checkDocumentDirty" -> withFile(params) { adapter, path ->
            JsonObject().apply { addProperty("isDirty", adapter.isDirty(path)) }
        }

        "saveDocument" -> withFile(params) { adapter, path ->
            JsonObject().apply { addProperty("saved", adapter.save(path)) }
        }

        "closeTab" -> withFile(params) { adapter, path ->
            JsonObject().apply { addProperty("closed", adapter.closeTab(path)) }
        }

        "getDiagnostics" -> JsonObject().apply {
            val path = params?.get("uri")
                ?.takeIf { it.isJsonPrimitive }
                ?.asString
                ?.let(::uriToPath)
            val diags = onEdt {
                activeOrFirstProject()?.let { ProjectAdapter.getInstance(it).getDiagnostics(path) }
                    ?: emptyList()
            }
            add("diagnostics", JsonRpc.toJsonTree(diags))
        }

        // Capability not advertised -> METHOD_NOT_FOUND (protocol.md §4).
        "openDiff" -> throw RpcException.methodNotFound(method)

        else -> throw RpcException.methodNotFound(method)
    }

    private fun handleInitialize(): JsonObject = JsonObject().apply {
        addProperty("ideName", ApplicationNamesInfo.getInstance().productName)
        addProperty("ideVersion", ApplicationInfo.getInstance().fullVersion)
        addProperty("protocolVersion", 1)
        add("capabilities", JsonObject().apply {
            addProperty("openDiff", false)
            addProperty("diagnostics", true)
            addProperty("executeCode", false)
        })
    }

    private fun handleGetWorkspaceFolders(): JsonObject {
        val folders = onEdt {
            ProjectManager.getInstance().openProjects
                .filter { !it.isDisposed }
                .flatMap { ProjectAdapter.getInstance(it).workspaceFolders() }
                .distinct()
        }
        return JsonObject().apply {
            add("folders", JsonArray().apply { folders.forEach { add(pathToUri(it)) } })
        }
    }

    private fun withFile(params: JsonObject?, op: (ProjectAdapter, String) -> JsonObject): JsonObject {
        val uri = params.requireString("uri")
        return onEdt {
            val path = uriToPath(uri)
            val project = projectForPath(path)
                ?: throw RpcException.invalidParams("No open project contains $uri")
            op(ProjectAdapter.getInstance(project), path)
        }
    }

    private fun latestNonEmptySelection(): Selection? {
        latestSelection?.let { if (!it.project.isDisposed) return it.selection }
        return onEdt { activeOrFirstProject()?.let { ProjectAdapter.getInstance(it).currentSelectionIfAny() } }
    }

    // ---------------------------------------------------------------- project tracking

    private fun activeOrFirstProject(): Project? {
        lastActiveProject?.let { if (!it.isDisposed) return it }
        return ProjectManager.getInstance().openProjects.firstOrNull { !it.isDisposed }
    }

    /** Project whose basePath contains [path]; falls back to the active/first open project. */
    private fun projectForPath(path: String): Project? {
        val projects = ProjectManager.getInstance().openProjects.filter { !it.isDisposed }
        return projects.firstOrNull { p -> p.basePath?.let { isUnder(it, path) } == true }
            ?: activeOrFirstProject()
    }

    private fun isUnder(base: String, path: String): Boolean {
        val b = base.replace('\\', '/').trimEnd('/')
        val p = path.replace('\\', '/')
        if (p.equals(b, ignoreCase = !SystemInfo.isFileSystemCaseSensitive)) return true
        val prefix = "$b/"
        return p.startsWith(prefix, ignoreCase = !SystemInfo.isFileSystemCaseSensitive)
    }

    fun noteProjectActive(project: Project) {
        lastActiveProject = project
    }

    /** Recomputes workspace folders, rewrites the lockfile, broadcasts workspace_changed on change. */
    fun refreshWorkspace() {
        val folders = ProjectManager.getInstance().openProjects
            .filter { !it.isDisposed }
            .mapNotNull { it.basePath }
            .distinct()
        val changed = folders != workspaceFolders
        workspaceFolders = folders
        if (lockfilePath != null) {
            ApplicationManager.getApplication().executeOnPooledThread { writeLockfile() }
        }
        if (changed) {
            broadcastNotification("workspace_changed", JsonObject().apply {
                add("folders", JsonArray().apply { folders.forEach { add(pathToUri(it)) } })
            })
        }
    }

    fun onProjectClosed(project: Project) {
        if (latestSelection?.project === project) latestSelection = null
        if (lastActiveProject === project) lastActiveProject = null
        // projectClosed fires while the project is still listed; defer past disposal.
        ApplicationManager.getApplication().invokeLater {
            refreshWorkspace()
            publishEditorsChanged()
        }
    }

    // ---------------------------------------------------------------- notifications (EDT callers)

    /** Must be called on the EDT (reads FileEditorManager state). */
    fun publishEditorsChanged() {
        broadcastNotification("editors_changed", JsonObject().apply {
            add("editors", JsonRpc.toJsonTree(collectEditors()))
        })
    }

    /** Must be called on the EDT. [selection] may be null (nothing selected). */
    fun publishSelectionChanged(project: Project, selection: Selection?) {
        noteProjectActive(project)
        // "latest" keeps getLatestSelection semantics: last NON-EMPTY selection.
        // Caret-only publishes (text == "") update clients but not this cache.
        if (selection != null && selection.text.isNotEmpty()) {
            latestSelection = CachedSelection(project, selection)
            ProjectAdapter.getInstance(project).noteSelection(selection)
        }
        broadcastNotification("selection_changed", selectionResult(selection))
    }

    /**
     * Coarse diagnostics hint (protocol.md §5): clients re-pull `getDiagnostics`
     * lazily, so only the affected URIs are sent. Must be called on the EDT.
     */
    fun publishDiagnosticsChanged() {
        val uris = collectEditors().map { it.uri }
        if (uris.isEmpty()) return
        broadcastNotification("diagnostics_changed", JsonObject().apply {
            add("uris", JsonRpc.toJsonTree(uris))
        })
    }

    /** Must be called on the EDT. */
    fun publishAtMention(project: Project, selection: Selection, text: String) {
        noteProjectActive(project)
        latestSelection = CachedSelection(project, selection)
        ProjectAdapter.getInstance(project).noteSelection(selection)
        broadcastNotification("at_mentioned", JsonObject().apply {
            add("selection", JsonRpc.toJsonTree(selection))
            addProperty("text", text)
        })
    }

    /** Union of open editors across all projects; isActive only within the active project. */
    private fun collectEditors(): List<Editor> {
        val active = activeOrFirstProject()
        val result = ArrayList<Editor>()
        for (p in ProjectManager.getInstance().openProjects) {
            if (p.isDisposed) continue
            val editors = ProjectAdapter.getInstance(p).openEditors()
            if (p === active) result.addAll(editors) else editors.mapTo(result) { it.copy(isActive = false) }
        }
        return result
    }

    private fun broadcastNotification(method: String, params: JsonElement) {
        sendToAll(server, JsonRpc.notification(method, params))
    }

    private fun sendToAll(s: BridgeWebSocketServer?, text: String) {
        s ?: return
        for (c in s.clients) {
            try {
                if (c.isOpen) c.send(text)
            } catch (e: Exception) {
                // client vanished mid-broadcast; onClose will clean up
            }
        }
    }

    // ---------------------------------------------------------------- threading

    /**
     * Runs [block] on the EDT and returns its result. WS worker threads block here;
     * they hold no locks, so no deadlock with the EDT is possible.
     */
    private fun <T> onEdt(block: () -> T): T {
        val app = ApplicationManager.getApplication()
        if (app.isDispatchThread) return block()
        // 2024.3 SDK only has invokeAndWait(Runnable, …) overloads — ferry the
        // result out through an AtomicReference (verified via javap on util-8.jar).
        val result = AtomicReference<T>()
        app.invokeAndWait({ result.set(block()) }, ModalityState.defaultModalityState())
        return result.get()
    }

    // ---------------------------------------------------------------- lockfile (protocol.md §1)

    private fun lockDir(): Path = Paths.get(System.getProperty("user.home"), ".omp", "ide")

    private fun buildLockfileJson(): String = JsonObject().apply {
        addProperty("pid", ProcessHandle.current().pid())
        add("workspaceFolders", JsonArray().apply { workspaceFolders.forEach { add(it) } })
        addProperty("ideName", ApplicationNamesInfo.getInstance().productName)
        addProperty("transport", "ws")
        addProperty("runningInWindows", SystemInfo.isWindows)
        addProperty("authToken", authToken)
    }.toString()

    private fun writeLockfile() {
        val file = lockfilePath ?: return
        try {
            ensurePrivateDir(file.parent)
            if (Files.notExists(file)) createPrivateFile(file)
            Files.write(file, buildLockfileJson().toByteArray(StandardCharsets.UTF_8))
            trySetOwnerOnly(file)
        } catch (e: Exception) {
            log.warn("OMP IDE Bridge: failed to write lockfile $file", e)
        }
    }

    private fun ensurePrivateDir(dir: Path) {
        if (Files.isDirectory(dir)) return
        try {
            Files.createDirectories(dir, posixAttr("rwx------"))
        } catch (e: UnsupportedOperationException) {
            // non-POSIX filesystem (win32) — best effort default ACLs
            Files.createDirectories(dir)
        } catch (e: FileAlreadyExistsException) {
            // lost a race — fine
        }
    }

    private fun createPrivateFile(file: Path) {
        try {
            Files.createFile(file, posixAttr("rw-------"))
        } catch (e: UnsupportedOperationException) {
            Files.createFile(file)
        } catch (e: FileAlreadyExistsException) {
            // lost a race — fine
        }
    }

    private fun trySetOwnerOnly(file: Path) {
        if (SystemInfo.isWindows) return
        try {
            Files.setPosixFilePermissions(file, PosixFilePermissions.fromString("rw-------"))
        } catch (e: Exception) {
            // best effort (e.g. non-POSIX mount)
        }
    }

    private fun posixAttr(perms: String) =
        PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString(perms))
}
