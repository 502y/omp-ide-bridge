/**
 * Local stand-in for `@oh-my-pi/pi-coding-agent` extension types.
 *
 * The real package ships inside the omp runtime and is not published to npm,
 * so this shim models only the documented ExtensionAPI surface this module
 * touches (docs/extensions.md). Members we don't use are intentionally absent.
 */
declare module "@oh-my-pi/pi-coding-agent" {
	export interface ExtensionUIContextLike {
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
