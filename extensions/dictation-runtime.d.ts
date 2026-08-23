declare const process: {
	readonly pid: number;
};

type DictationThemeColor = "error" | "warning";

type DictationTheme = {
	fg(color: DictationThemeColor, text: string): string;
};

type DictationUi = {
	readonly theme: DictationTheme;
	notify(message: string, level: "info" | "warning" | "error"): void;
	pasteToEditor(text: string): void;
	setStatus(id: string, text: string | undefined): void;
};

declare module "@earendil-works/pi-coding-agent" {
	export type ExtensionContext = {
		readonly mode: "tui" | "rpc" | "json" | "print";
		readonly ui: DictationUi;
	};

	type ExecResult = {
		readonly stdout: string;
		readonly stderr: string;
		readonly code: number;
		readonly killed: boolean;
	};

	type ExecOptions = {
		readonly signal?: AbortSignal;
		readonly timeout?: number;
	};

	type EventHandler<Event> = (
		event: Event,
		ctx: ExtensionContext,
	) => void | Promise<void>;

	type SessionShutdownEvent = {
		readonly reason: "quit" | "reload" | "new" | "resume" | "fork";
	};

	export type ExtensionAPI = {
		exec(
			command: string,
			args: string[],
			options?: ExecOptions,
		): Promise<ExecResult>;
		on(event: "session_start", handler: EventHandler<unknown>): void;
		on(
			event: "session_shutdown",
			handler: EventHandler<SessionShutdownEvent>,
		): void;
		registerShortcut(
			shortcut: string,
			options: {
				readonly description: string;
				readonly handler: (ctx: ExtensionContext) => void | Promise<void>;
			},
		): void;
		registerCommand(
			name: string,
			options: {
				readonly description: string;
				readonly handler: (
					args: string,
					ctx: ExtensionContext,
				) => void | Promise<void>;
			},
		): void;
	};
}
