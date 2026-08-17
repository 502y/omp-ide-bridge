package com.omp.idebridge

import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.CommonDataKeys
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.project.DumbAware
import com.intellij.openapi.project.Project
import java.util.Locale

/**
 * "Mention to OMP" editor context-menu action (protocol.md §5, at_mentioned).
 * Enabled only when the editor has a non-collapsed selection; broadcasts the
 * selection plus a preformatted markdown block to every connected OMP client.
 */
class MentionAction : AnAction(), DumbAware {

    override fun getActionUpdateThread(): ActionUpdateThread = ActionUpdateThread.EDT

    override fun update(e: AnActionEvent) {
        val editor = e.getData(CommonDataKeys.EDITOR)
        e.presentation.isEnabledAndVisible =
            e.project != null && editor != null && editor.selectionModel.hasSelection()
    }

    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val editor = e.getData(CommonDataKeys.EDITOR) ?: return
        if (!editor.selectionModel.hasSelection()) return
        val adapter = ProjectAdapter.getInstance(project)
        val selection = adapter.selectionFrom(editor) ?: return
        val language = FileDocumentManager.getInstance().getFile(editor.document)
            ?.fileType?.name?.lowercase(Locale.ROOT) ?: ""
        adapter.noteSelection(selection)
        IdeBridgeServer.getInstance().publishAtMention(
            project,
            selection,
            buildMentionText(project, selection, language),
        )
    }

    /**
     * Preformatted markdown: `path:Lx-Ly` header (project-relative when possible,
     * 1-based line numbers) followed by a fenced code block with the selected text.
     */
    private fun buildMentionText(project: Project, selection: Selection, language: String): String {
        val absolute = uriToPath(selection.uri)
        val base = project.basePath?.replace('\\', '/')?.trimEnd('/')
        val displayPath = if (base != null && absolute.startsWith("$base/")) {
            absolute.substring(base.length + 1)
        } else {
            absolute
        }
        val startLine = selection.start.line + 1
        val endLine = selection.end.line + 1
        val lineRef = if (endLine > startLine) "L$startLine-L$endLine" else "L$startLine"
        return buildString {
            append(displayPath).append(':').append(lineRef).append('\n')
            append("```").append(language).append('\n')
            append(selection.text)
            if (!selection.text.endsWith('\n')) append('\n')
            append("```")
        }
    }
}
