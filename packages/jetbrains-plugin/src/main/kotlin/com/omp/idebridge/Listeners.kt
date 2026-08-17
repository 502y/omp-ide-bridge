package com.omp.idebridge

import com.intellij.codeInsight.daemon.DaemonCodeAnalyzer
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.editor.EditorFactory
import com.intellij.openapi.editor.event.CaretEvent
import com.intellij.openapi.editor.event.CaretListener
import com.intellij.openapi.editor.event.SelectionEvent
import com.intellij.openapi.editor.event.SelectionListener
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.fileEditor.FileEditorManagerEvent
import com.intellij.openapi.fileEditor.FileEditorManagerListener
import com.intellij.openapi.project.DumbAware
import com.intellij.openapi.project.Project
import com.intellij.openapi.project.ProjectManagerListener
import com.intellij.openapi.startup.ProjectActivity
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.util.Alarm

/**
 * Forces IdeBridgeServer startup and installs the per-project listeners that drive
 * the server→client notifications of protocol.md §5.
 *
 * ProjectActivity is the non-deprecated successor of StartupActivity.Background;
 * DumbAware because we do not need indices.
 */
class IdeBridgeStartupActivity : ProjectActivity, DumbAware {

    override suspend fun execute(project: Project) {
        val server = IdeBridgeServer.getInstance()
        server.ensureStarted()
        // Keeps lockfile workspaceFolders in sync (runs per opened project; this
        // is also why WorkspaceListener doesn't need the deprecated projectOpened).
        server.refreshWorkspace()
        val adapter = ProjectAdapter.getInstance(project)

        // selection_changed: debounced ≤150 ms per protocol.md §5. The Alarm runs its
        // requests on the EDT (SWING_THREAD), where editor state may be read freely.
        // Publishes the caret-inclusive current selection; null when no editor is open
        // (closing the last tab clears the client's status line).
        val selectionAlarm = Alarm(Alarm.ThreadToUse.SWING_THREAD, adapter)
        val scheduleSelectionPublish = {
            selectionAlarm.cancelAllRequests()
            selectionAlarm.addRequest({
                if (project.isDisposed) return@addRequest
                server.publishSelectionChanged(project, adapter.currentSelection())
            }, SELECTION_DEBOUNCE_MS)
        }

        // editors_changed: tab opened/closed/activated (protocol.md §5). Editor
        // topology changes also change the effective selection without any caret
        // event, so a selection publish is scheduled alongside.
        // Message-bus connection is disposed together with the project via `adapter`.
        project.messageBus.connect(adapter).subscribe(
            FileEditorManagerListener.FILE_EDITOR_MANAGER,
            object : FileEditorManagerListener {
                override fun fileOpened(source: FileEditorManager, file: VirtualFile) {
                    publishEditorsChanged()
                    scheduleSelectionPublish()
                }
                override fun fileClosed(source: FileEditorManager, file: VirtualFile) {
                    publishEditorsChanged()
                    scheduleSelectionPublish()
                }
                override fun selectionChanged(event: FileEditorManagerEvent) {
                    publishEditorsChanged()
                    scheduleSelectionPublish()
                }
            },
        )

        // Caret-only moves (mouse clicks) do NOT reliably fire SelectionListener on the
        // platform, so a CaretListener covers them; both funnel into the same debounced,
        // idempotent publish.
        EditorFactory.getInstance().eventMulticaster.addSelectionListener(
            object : SelectionListener {
                override fun selectionChanged(e: SelectionEvent) {
                    if (e.editor.project === project) scheduleSelectionPublish()
                }
            },
            adapter,
        )
        EditorFactory.getInstance().eventMulticaster.addCaretListener(
            object : CaretListener {
                override fun caretPositionChanged(event: CaretEvent) {
                    if (event.editor.project === project) scheduleSelectionPublish()
                }
            },
            adapter,
        )

        // diagnostics_changed: debounced ≤500 ms per protocol.md §5. The daemon
        // fires on the EDT after each analysis pass; payload is only a URI hint,
        // clients re-pull getDiagnostics lazily.
        val diagnosticsAlarm = Alarm(Alarm.ThreadToUse.SWING_THREAD, adapter)
        project.messageBus.connect(adapter).subscribe(
            DaemonCodeAnalyzer.DAEMON_EVENT_TOPIC,
            object : DaemonCodeAnalyzer.DaemonListener {
                override fun daemonFinished() {
                    diagnosticsAlarm.cancelAllRequests()
                    diagnosticsAlarm.addRequest({
                        if (project.isDisposed) return@addRequest
                        server.publishDiagnosticsChanged()
                    }, DIAGNOSTICS_DEBOUNCE_MS)
                }
            },
        )
    }

    private fun publishEditorsChanged() {
        val app = ApplicationManager.getApplication()
        if (app.isDispatchThread) {
            doPublishEditorsChanged()
        } else {
            app.invokeLater { doPublishEditorsChanged() }
        }
    }

    private fun doPublishEditorsChanged() {
        IdeBridgeServer.getInstance().publishEditorsChanged()
    }

    private companion object {
        const val SELECTION_DEBOUNCE_MS = 150
        const val DIAGNOSTICS_DEBOUNCE_MS = 500
    }
}

/**
 * Application-level workspace tracking (protocol.md §1/§5): keeps the lockfile's
 * workspaceFolders in sync with the set of open projects and broadcasts
 * workspace_changed. Registered declaratively in plugin.xml (applicationListeners).
 */
class WorkspaceListener : ProjectManagerListener {

    override fun projectClosed(project: Project) {
        IdeBridgeServer.getInstance().onProjectClosed(project)
    }
}
