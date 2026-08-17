package com.omp.idebridge

import com.intellij.codeInsight.daemon.impl.DaemonCodeAnalyzerEx
import com.intellij.codeInsight.daemon.impl.HighlightInfo
import com.intellij.lang.annotation.HighlightSeverity
import com.intellij.openapi.Disposable
import com.intellij.openapi.components.Service
import com.intellij.openapi.editor.Document
import com.intellij.openapi.editor.Editor
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.fileEditor.OpenFileDescriptor
import com.intellij.openapi.fileEditor.TextEditor
import com.intellij.openapi.progress.ProcessCanceledException
import com.intellij.util.CommonProcessors
import com.intellij.openapi.project.Project
import com.intellij.openapi.roots.ProjectRootManager
import com.intellij.openapi.vfs.LocalFileSystem
import com.intellij.openapi.vfs.VirtualFile
import java.io.File
import java.net.URI
import java.nio.file.Paths

/**
 * Per-project bridge to IntelliJ Platform APIs (protocol.md §4).
 *
 * All public methods that read IDE state MUST be called on the EDT (or under a read
 * action); IdeBridgeServer dispatches them via invokeAndWait. VFS paths are kept in
 * the platform's '/'-separated form; file:// URI conversion happens only at the
 * boundary (see [pathToUri] / [uriToPath] below).
 *
 * Registered as a light service (@Service); it MUST NOT also be declared in plugin.xml.
 */
@Service(Service.Level.PROJECT)
class ProjectAdapter(private val project: Project) : Disposable {

    /** Last non-empty selection in this project; used for getLatestSelection fallback. */
    @Volatile
    private var lastNonEmptySelection: Selection? = null

    companion object {
        fun getInstance(project: Project): ProjectAdapter =
            project.getService(ProjectAdapter::class.java)
    }

    // ---------------------------------------------------------------- selections

    /** Current selection of the focused text editor; caret-only yields empty text. Null when no editor. */
    fun currentSelection(): Selection? {
        val editor = FileEditorManager.getInstance(project).selectedTextEditor ?: return null
        return selectionFrom(editor)
    }

    /** Like [currentSelection] but null unless an actual (non-collapsed) selection exists. */
    fun currentSelectionIfAny(): Selection? {
        val editor = FileEditorManager.getInstance(project).selectedTextEditor ?: return null
        if (!editor.selectionModel.hasSelection()) return null
        return selectionFrom(editor)
    }

    fun latestSelection(): Selection? = lastNonEmptySelection

    fun noteSelection(selection: Selection) {
        lastNonEmptySelection = selection
    }

    /** Builds a protocol Selection (0-based LSP-style positions) from a platform editor. */
    fun selectionFrom(editor: Editor): Selection? {
        val document = editor.document
        val file = FileDocumentManager.getInstance().getFile(document) ?: return null
        val sm = editor.selectionModel
        val hasSelection = sm.hasSelection()
        val startOffset = if (hasSelection) sm.selectionStart else editor.caretModel.offset
        val endOffset = if (hasSelection) sm.selectionEnd else startOffset
        val start = editor.offsetToLogicalPosition(startOffset)
        val end = editor.offsetToLogicalPosition(endOffset)
        return Selection(
            uri = pathToUri(file.path),
            start = Position(start.line, start.column),
            end = Position(end.line, end.column),
            text = if (hasSelection) sm.selectedText ?: "" else "",
        )
    }

    // ---------------------------------------------------------------- workspace

    /** project.basePath plus content roots, deduplicated, native absolute paths. */
    fun workspaceFolders(): List<String> {
        val result = LinkedHashSet<String>()
        project.basePath?.let { result.add(it) }
        for (root in ProjectRootManager.getInstance(project).contentRoots) {
            result.add(root.path)
        }
        return result.toList()
    }

    // ---------------------------------------------------------------- editors

    /** One entry per open file; isActive for files selected in an editor tab. */
    fun openEditors(): List<com.omp.idebridge.Editor> {
        val fem = FileEditorManager.getInstance(project)
        val selected = fem.selectedFiles.toHashSet()
        return fem.openFiles.map { file ->
            com.omp.idebridge.Editor(uri = pathToUri(file.path), isActive = file in selected)
        }
    }

    // ---------------------------------------------------------------- file operations

    /** Opens [path] in an editor tab, optionally at a 0-based logical line/character. */
    fun openFile(path: String, line: Int?, character: Int?): Boolean {
        val file = findFile(path)
        val descriptor = if (line != null) {
            OpenFileDescriptor(project, file, line, character ?: 0)
        } else {
            OpenFileDescriptor(project, file)
        }
        descriptor.navigate(true)
        return true
    }

    fun isDirty(path: String): Boolean {
        val file = findFile(path)
        val document = FileDocumentManager.getInstance().getDocument(file) ?: return false
        return FileDocumentManager.getInstance().isDocumentUnsaved(document)
    }

    fun save(path: String): Boolean {
        val file = findFile(path)
        val document = FileDocumentManager.getInstance().getDocument(file) ?: return false
        FileDocumentManager.getInstance().saveDocument(document)
        return true
    }

    fun closeTab(path: String): Boolean {
        val file = findFile(path)
        val fem = FileEditorManager.getInstance(project)
        if (!fem.isFileOpen(file)) return false
        fem.closeFile(file)
        return true
    }

    private fun findFile(path: String): VirtualFile =
        LocalFileSystem.getInstance().findFileByPath(path)
            ?: throw RpcException.invalidParams("File not found: $path")

    // ---------------------------------------------------------------- diagnostics

    /**
     * Current daemon highlights (protocol.md §4 `getDiagnostics`). [path] null means
     * "all open text editors". Passive read: returns what the daemon has already
     * computed — a file that was never analyzed simply yields no entries.
     *
     * Uses the semi-internal DaemonCodeAnalyzerEx.processHighlights (stable for years
     * and used by many plugins, but not part of the open API — see DEV-NOTE).
     * MUST be called on the EDT.
     */
    fun getDiagnostics(path: String?): List<Diagnostic> {
        val fdm = FileDocumentManager.getInstance()
        val targets: List<Pair<VirtualFile, Document>> = if (path != null) {
            val file = LocalFileSystem.getInstance().findFileByPath(path) ?: return emptyList()
            val doc = fdm.getDocument(file) ?: return emptyList()
            listOf(file to doc)
        } else {
            FileEditorManager.getInstance(project).allEditors.mapNotNull { fe ->
                val editor = (fe as? TextEditor)?.editor ?: return@mapNotNull null
                val vf = fdm.getFile(editor.document) ?: return@mapNotNull null
                vf to editor.document
            }
        }
        val out = mutableListOf<Diagnostic>()
        for ((file, doc) in targets) {
            val collector = CommonProcessors.CollectProcessor<HighlightInfo>()
            try {
                // Static on DaemonCodeAnalyzerEx (verified via javap on app-client.jar).
                DaemonCodeAnalyzerEx.processHighlights(
                    doc, project, HighlightSeverity.INFORMATION, 0, doc.textLength, collector,
                )
            } catch (e: ProcessCanceledException) {
                continue
            }
            for (info in collector.results) {
                val message = info.toolTip ?: info.description ?: continue
                out += Diagnostic(
                    uri = pathToUri(file.path),
                    range = Range(offsetToPosition(doc, info.startOffset), offsetToPosition(doc, info.endOffset)),
                    severity = severityOf(info.severity),
                    message = message,
                    source = null,
                )
            }
        }
        return out
    }

    /** Document offsets may be stale by a few chars mid-typing; clamp before mapping. */
    private fun offsetToPosition(doc: Document, offset: Int): Position {
        val clamped = offset.coerceIn(0, doc.textLength)
        val line = doc.getLineNumber(clamped)
        return Position(line, clamped - doc.getLineStartOffset(line))
    }

    private fun severityOf(severity: HighlightSeverity): String = when {
        severity.myVal >= HighlightSeverity.ERROR.myVal -> "error"
        severity.myVal >= HighlightSeverity.WARNING.myVal -> "warning"
        severity.myVal >= HighlightSeverity.INFORMATION.myVal -> "information"
        else -> "hint"
    }

    override fun dispose() {
        lastNonEmptySelection = null
    }
}

// ------------------------------------------------------------------------
// file:// URI ⇄ native path helpers (protocol.md §3: all URIs are file://,
// POSIX separators, win32 drive letters as file:///C:/...).
// ------------------------------------------------------------------------

internal fun pathToUri(path: String): String {
    var p = path.replace(File.separatorChar, '/')
    if (!p.startsWith("/")) p = "/$p"
    // Empty authority -> "file:///..."; the URI constructor percent-encodes the path.
    return URI("file", "", p, null).toASCIIString()
}

/** @throws RpcException INVALID_PARAMS for malformed or non-file URIs. */
internal fun uriToPath(uri: String): String {
    val parsed = try {
        URI(uri)
    } catch (e: Exception) {
        throw RpcException.invalidParams("Malformed uri: $uri")
    }
    if (parsed.scheme != "file") throw RpcException.invalidParams("Not a file:// uri: $uri")
    val path = try {
        Paths.get(parsed)
    } catch (e: Exception) {
        throw RpcException.invalidParams("Malformed file uri: $uri")
    }
    return path.toAbsolutePath().normalize().toString().replace(File.separatorChar, '/')
}
