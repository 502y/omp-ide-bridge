/**
 * OMP IDE Bridge — connects OMP to a running IDE (VS Code family / JetBrains)
 * so every turn sees the active file, selection, open tabs, and diagnostics.
 *
 * Wire protocol: ../../docs/protocol.md (IDE = WS server, OMP = client).
 */

import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { formatSelectionStatus } from "./src/context";
import { OmpIdeBridge } from "./src/core";
import { scanCandidates } from "./src/lockfile";
import type { AtMention, Selection } from "./src/protocol";

interface UiHandle {
	notify(text: string, level?: string): void;
	setStatus(key: string, text: string): void;
}

function text(text: string, details: Record<string, unknown> = {}, isError = false) {
	return { content: [{ type: "text" as const, text }], details, isError };
}

export default function ideBridge(pi: ExtensionAPI) {
	pi.setLabel("IDE Bridge");

	let ui: UiHandle | null = null;
	let cwd = "";

	const bridge = new OmpIdeBridge({
		onStatus: (msg) => ui?.notify(msg, "info"),
		onSelectionStatus: (sel: Selection | null) => {
			// Live IDE selection in the status bar (empty string clears the slot).
			ui?.setStatus("ide", sel === null ? "" : formatSelectionStatus(sel, cwd));
		},
		onAtMentioned: (m: AtMention) => {
			pi.sendMessage(
				{
					customType: "ide-mention",
					content: m.text,
					display: true,
					attribution: "user",
				},
				{ deliverAs: "nextTurn", triggerTurn: false },
			);
			ui?.notify("IDE selection mentioned — will be included next turn", "info");
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		ui = ctx.ui as unknown as UiHandle;
		cwd = ctx.cwd;
		bridge.start(ctx.cwd);
	});

	pi.on("session_shutdown", async () => {
		bridge.stop();
	});

	// Per-turn injection of the live IDE state (deduped inside the bridge).
	pi.on("before_agent_start", async () => {
		const content = bridge.getContextInjection();
		if (content === null) return;
		return {
			message: {
				customType: "ide-context",
				content,
				display: false,
				attribution: "ide",
			},
		};
	});

	const { z } = pi.zod;

	pi.registerTool({
		name: "ide_get_editor_context",
		label: "IDE Editor Context",
		description:
			"Get the connected IDE's live editor state: workspace folders, open editors, and the current selection. Positions are 0-based (LSP convention). Requires the OMP IDE Bridge plugin running in the IDE.",
		parameters: z.object({}),
		async execute(_id, _params, _signal, _onUpdate, _ctx) {
			try {
				const ctx = await bridge.getEditorContext();
				return text(JSON.stringify(ctx, null, 2), { connected: true });
			} catch (err) {
				return text(`IDE not available: ${(err as Error).message}`, {}, true);
			}
		},
	});

	pi.registerTool({
		name: "ide_open_file",
		label: "IDE Open File",
		description:
			"Open a file in the connected IDE at an optional 0-based line/character position (LSP convention).",
		parameters: z.object({
			path: z.string().describe("File path (absolute or relative to cwd)"),
			line: z.number().optional().describe("0-based line to reveal"),
			character: z.number().optional().describe("0-based character offset"),
		}),
		async execute(
			_id,
			params: { path: string; line?: number; character?: number },
			_signal,
			_onUpdate,
			_ctx,
		) {
			try {
				await bridge.openFile(params.path, params.line, params.character);
				return text(`Opened ${params.path} in IDE`);
			} catch (err) {
				return text(`IDE open failed: ${(err as Error).message}`, {}, true);
			}
		},
	});

	pi.registerTool({
		name: "ide_get_diagnostics",
		label: "IDE Diagnostics",
		description:
			"Get language-server diagnostics (errors/warnings) from the connected IDE, optionally for one file. Positions in the result are 0-based (LSP convention).",
		parameters: z.object({
			path: z.string().optional().describe("Restrict to this file"),
		}),
		async execute(_id, params: { path?: string }, _signal, _onUpdate, _ctx) {
			try {
				const res = await bridge.getDiagnostics(params.path);
				return text(JSON.stringify(res, null, 2));
			} catch (err) {
				return text(`IDE diagnostics failed: ${(err as Error).message}`, {}, true);
			}
		},
	});

	pi.registerTool({
		name: "ide_save_document",
		label: "IDE Save Document",
		description: "Save a dirty document in the connected IDE.",
		parameters: z.object({
			path: z.string().describe("File path (absolute or relative to cwd)"),
		}),
		async execute(_id, params: { path: string }, _signal, _onUpdate, _ctx) {
			try {
				await bridge.saveDocument(params.path);
				return text(`Saved ${params.path}`);
			} catch (err) {
				return text(`IDE save failed: ${(err as Error).message}`, {}, true);
			}
		},
	});

	pi.registerTool({
		name: "ide_open_diff",
		label: "IDE Open Diff",
		description:
			"Show a proposed change as a native diff in the connected IDE and wait for the user to accept (save) or reject (close). May block until the user decides.",
		parameters: z.object({
			path: z.string().describe("Target file the diff applies to"),
			newText: z.string().describe("Full proposed new content"),
			tabName: z.string().optional().describe("Diff tab title"),
		}),
		async execute(
			_id,
			params: { path: string; newText: string; tabName?: string },
			_signal,
			_onUpdate,
			_ctx,
		) {
			try {
				const res = await bridge.openDiff(params.path, params.newText, params.tabName);
				return text(JSON.stringify(res), { reviewed: true });
			} catch (err) {
				return text(`IDE diff failed: ${(err as Error).message}`, {}, true);
			}
		},
	});

	pi.registerCommand("ide", {
		description: "IDE bridge: status, list, connect (/ide N), disconnect (/ide off)",
		handler: async (args, ctx) => {
			const uiCtx = ctx.ui as unknown as UiHandle;
			const arg = args.trim();
			if (arg === "off") {
				bridge.disconnect();
				uiCtx.notify("IDE bridge disconnected", "info");
				return;
			}
			if (/^\d+$/.test(arg)) {
				const idx = Number(arg) - 1;
				const candidates = scanCandidates().sort((a, b) => b.mtimeMs - a.mtimeMs);
				const target = candidates[idx];
				if (!target) {
					uiCtx.notify(`No IDE #${arg}; run /ide to list`, "warning");
					return;
				}
				const ok = await bridge.connectTo(target.port);
				uiCtx.notify(
					ok ? `Connected to ${target.lock.ideName}` : "Connection failed",
					ok ? "info" : "error",
				);
				return;
			}
			const st = bridge.status();
			const lines = [
				st.connected
					? `Connected: ${st.ideName} (port ${st.port})`
					: "Not connected",
				...st.candidates.map(
					(c, i) => `  ${i + 1}. ${c.ideName} :${c.port} — ${c.folders.join(", ")}`,
				),
			];
			if (st.candidates.length === 0) lines.push("  (no IDEs discovered)");
			uiCtx.notify(lines.join("\n"), "info");
		},
	});
}
