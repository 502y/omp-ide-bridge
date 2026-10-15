/**
 * Local stand-in for `@oh-my-pi/pi-coding-agent` extension types.
 *
 * The real package ships inside the omp runtime and is not published to npm,
 * so this shim models only the documented ExtensionAPI surface this module
 * touches (docs/extensions.md). Members we don't use are intentionally absent.
 */
declare module "@oh-my-pi/pi-coding-agent" {
	export interface ExtensionUIContextLike {
		readonly theme: { symbol(key: "icon.file"): string };
		notify(text: string, level?: string): void;
		setStatus(key: string, text: string): void;
	}

	export interface ExtensionContextLike {
		cwd: string;
		ui: ExtensionUIContextLike;
		hasUI: boolean;
	}

	export interface ToolResultLike {
		content: Array<{ type: "text"; text: string }>;
		details?: Record<string, unknown>;
		isError?: boolean;
	}

	export interface ToolCallEvent {
		type: "tool_call";
		toolName: string;
		toolCallId: string;
		input: Record<string, unknown>;
	}

	export interface EditToolPerFileResult {
		path: string;
		diff: string;
		op?: "create" | "delete" | "update";
		move?: string;
		sourcePath?: string;
		oldText?: string;
		newText?: string;
		isError?: boolean;
		snapshotsPruned?: boolean;
	}

	export interface EditToolDetails {
		diff: string;
		path?: string;
		op?: "create" | "delete" | "update";
		move?: string;
		sourcePath?: string;
		oldText?: string;
		newText?: string;
		snapshotsPruned?: boolean;
		perFileResults?: EditToolPerFileResult[];
	}

	export interface ToolResultEvent {
		type: "tool_result";
		toolName: string;
		toolCallId: string;
		input: Record<string, unknown>;
		content: unknown[];
		details: unknown;
		isError: boolean;
	}

	export interface AgentEndEvent {
		type: "agent_end";
		messages: unknown[];
		willContinue?: boolean;
		awaitingAsyncWork?: boolean;
	}

	export interface ZodScalar {
		describe(text: string): ZodScalar;
		optional(): ZodScalar;
	}

	export interface ZodLite {
		object(shape: Record<string, unknown>): unknown;
		string(): ZodScalar;
		number(): ZodScalar;
	}

	export interface ToolDefinitionLike<P> {
		name: string;
		label: string;
		description: string;
		parameters: unknown;
		execute(
			toolCallId: string,
			params: P,
			signal: AbortSignal | undefined,
			onUpdate: unknown,
			ctx: ExtensionContextLike,
		): Promise<ToolResultLike>;
	}

	export interface ExtensionAPI {
		/** The zod/v4 module object; destructure `z` from it. */
		zod: { z: ZodLite };
		setLabel(label: string): void;
		on(event: "tool_call", handler: (event: ToolCallEvent, ctx: ExtensionContextLike) => void | Promise<void>): void;
		on(event: "tool_result", handler: (event: ToolResultEvent, ctx: ExtensionContextLike) => void | Promise<void>): void;
		on(event: "agent_end", handler: (event: AgentEndEvent, ctx: ExtensionContextLike) => void): void;
		on(event: string, handler: (event: never, ctx: ExtensionContextLike) => unknown): void;
		registerTool<P>(def: ToolDefinitionLike<P>): void;
		registerCommand(
			name: string,
			def: {
				description: string;
				handler(args: string, ctx: ExtensionContextLike): unknown;
			},
		): void;
		sendMessage(
			message: {
				customType: string;
				content: string;
				display: boolean;
				attribution: string;
			},
			options?: { deliverAs?: string; triggerTurn?: boolean },
		): void;
	}
}
