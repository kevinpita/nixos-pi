declare module "@earendil-works/pi-tui" {
	export type AutocompleteItem = {
		value: string;
		label: string;
		description?: string;
	};

	export type AutocompleteSuggestions = {
		prefix: string;
		items: AutocompleteItem[];
	};

	export type AutocompleteOptions = {
		signal: AbortSignal;
	};

	export type AutocompleteProvider = {
		triggerCharacters?: string[];
		getSuggestions(
			lines: string[],
			cursorLine: number,
			cursorCol: number,
			options: AutocompleteOptions,
		): Promise<AutocompleteSuggestions | null> | AutocompleteSuggestions | null;
		applyCompletion(
			lines: string[],
			cursorLine: number,
			cursorCol: number,
			item: AutocompleteItem,
			prefix: string,
		): unknown;
		shouldTriggerFileCompletion?(
			lines: string[],
			cursorLine: number,
			cursorCol: number,
		): boolean;
	};

	export interface Focusable {
		focused: boolean;
	}

	export class Input implements Focusable {
		focused: boolean;
		getValue(): string;
		handleInput(data: string): void;
		render(width: number): string[];
		invalidate(): void;
	}

	export function matchesKey(data: string, key: string): boolean;
	export function truncateToWidth(
		text: string,
		width: number,
		ellipsis?: string,
	): string;
	export function visibleWidth(text: string): number;
}

declare module "@earendil-works/pi-coding-agent" {
	import type {
		AutocompleteProvider,
		AutocompleteSuggestions,
	} from "@earendil-works/pi-tui";

	export type Theme = {
		fg(color: string, text: string): string;
		bg(color: string, text: string): string;
		bold(text: string): string;
	};

	export type KeybindingsManager = {
		matches(data: string, action: string): boolean;
	};

	type Tui = {
		requestRender(): void;
	};

	type Component = {
		render(width: number): string[];
		handleInput?(data: string): void;
		invalidate(): void;
		dispose?(): void;
	};

	type CustomUiOptions = {
		overlay?: boolean;
		overlayOptions?: {
			anchor?: string;
			width?: number | string;
			minWidth?: number;
			maxHeight?: number | string;
			margin?: number;
		};
	};

	type ExtensionUi = {
		addAutocompleteProvider(
			factory: (current: AutocompleteProvider) => AutocompleteProvider,
		): void;
		custom<T>(
			factory: (
				tui: Tui,
				theme: Theme,
				keybindings: KeybindingsManager,
				done: (value: T) => void,
			) => Component,
			options?: CustomUiOptions,
		): Promise<T>;
		notify(message: string, type?: "info" | "warning" | "error"): void;
		pasteToEditor(text: string): void;
	};

	export type ExtensionContext = {
		cwd: string;
		mode: "tui" | "rpc" | "json" | "print";
		ui: ExtensionUi;
	};

	type ExecResult = {
		code: number;
		stdout: string;
		stderr: string;
		killed?: boolean;
	};

	type SessionStartEvent = {
		reason: "startup" | "reload" | "new" | "resume" | "fork";
		previousSessionFile?: string;
	};

	export type ExtensionAPI = {
		exec(
			command: string,
			args: string[],
			options?: { cwd?: string; timeout?: number; signal?: AbortSignal },
		): Promise<ExecResult>;
		on(
			event: "session_start",
			handler: (
				event: SessionStartEvent,
				ctx: ExtensionContext,
			) => Promise<void> | void,
		): void;
		registerCommand(
			name: string,
			options: {
				description?: string;
				handler: (args: string, ctx: ExtensionContext) => Promise<void> | void;
				getArgumentCompletions?: (
					prefix: string,
				) => AutocompleteSuggestions["items"] | null;
			},
		): void;
	};
}
