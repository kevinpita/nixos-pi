import {
	copyToClipboard,
	highlightCode,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { extractFencedCodeBlocks, type FencedCodeBlock } from "./parser.ts";

const MAX_PREVIEW_LENGTH = 72;
const PREVIEW_VISIBLE_LINES = 12;
const HORIZONTAL_SCROLL_COLUMNS = 4;

type MessagePart = {
	readonly type: string;
	readonly text?: string;
};

type BranchEntry = {
	readonly type: string;
	readonly message?: {
		readonly role: string;
		readonly content?: readonly MessagePart[];
	};
};

type PreviewTheme = {
	fg(color: string, text: string): string;
	bold(text: string): string;
};

type PreviewKeybindings = {
	matches(data: string, keybinding: string): boolean;
};

type PreviewTui = {
	requestRender(): void;
};

type PreviewComponent = {
	handleInput(data: string): void;
	render(width: number): string[];
	invalidate(): void;
};

type ExtensionCommandContext = {
	readonly mode: "tui" | "rpc" | "json" | "print";
	readonly sessionManager: {
		getBranch(): readonly BranchEntry[];
	};
	readonly ui: {
		notify(message: string, level?: "info" | "warning" | "error"): void;
		select(title: string, options: string[]): Promise<string | undefined>;
		custom<T>(
			factory: (
				tui: PreviewTui,
				theme: PreviewTheme,
				keybindings: PreviewKeybindings,
				done: (result: T) => void,
			) => PreviewComponent,
			options: {
				readonly overlay: true;
				readonly overlayOptions: {
					readonly anchor: "center";
					readonly width: string;
					readonly minWidth: number;
					readonly maxHeight: number;
					readonly margin: number;
				};
			},
		): Promise<T | undefined>;
	};
};

type ExtensionAPI = {
	registerCommand(
		name: string,
		options: {
			readonly description: string;
			readonly handler: (
				args: string,
				ctx: ExtensionCommandContext,
			) => Promise<void>;
		},
	): void;
};

function lastAssistantText(ctx: ExtensionCommandContext): string | undefined {
	const branch = ctx.sessionManager.getBranch();
	for (let index = branch.length - 1; index >= 0; index -= 1) {
		const entry = branch[index];
		if (entry.type !== "message" || entry.message?.role !== "assistant")
			continue;

		const text = (entry.message.content ?? [])
			.flatMap((part) =>
				part.type === "text" && typeof part.text === "string"
					? [part.text]
					: [],
			)
			.join("");
		if (text.trim()) return text;
	}

	return undefined;
}

function cleanLabel(text: string): string {
	return text
		.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function blockLabel(block: FencedCodeBlock, index: number): string {
	const language = cleanLabel(block.language ?? "text") || "text";
	const lineCount = block.content ? block.content.split("\n").length : 0;
	const firstContentLine = block.content
		.split("\n")
		.find((line) => line.trim());
	const rawPreview = cleanLabel(firstContentLine ?? "(empty)");
	const preview =
		rawPreview.length > MAX_PREVIEW_LENGTH
			? `${rawPreview.slice(0, MAX_PREVIEW_LENGTH - 3)}...`
			: rawPreview;
	const lineLabel = lineCount === 1 ? "line" : "lines";
	return `${index + 1}. ${language}, ${lineCount} ${lineLabel}: ${preview}`;
}

function previewLine(line: string): string {
	return line
		.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "�")
		.replace(/\t/g, "    ");
}

function sliceByColumns(text: string, start: number, width: number): string {
	if (width <= 0) return "";

	let column = 0;
	let visible = 0;
	let result = "";
	for (const character of text) {
		const characterWidth = Math.max(0, visibleWidth(character));
		const nextColumn = column + characterWidth;
		if (nextColumn <= start || column < start) {
			column = nextColumn;
			continue;
		}
		if (visible + characterWidth > width) break;
		result += character;
		visible += characterWidth;
		column = nextColumn;
	}
	return result;
}

class CodePreview implements PreviewComponent {
	private readonly lines: string[];
	private readonly language: string;
	private readonly theme: PreviewTheme;
	private readonly keybindings: PreviewKeybindings;
	private readonly requestRender: () => void;
	private readonly done: (copy: boolean) => void;
	private readonly maxLineWidth: number;
	private verticalOffset = 0;
	private horizontalOffset = 0;
	private codeWidth = 1;

	constructor(options: {
		block: FencedCodeBlock;
		theme: PreviewTheme;
		keybindings: PreviewKeybindings;
		requestRender: () => void;
		done: (copy: boolean) => void;
	}) {
		this.lines = options.block.content.split("\n").map(previewLine);
		this.language = cleanLabel(options.block.language ?? "text") || "text";
		this.theme = options.theme;
		this.keybindings = options.keybindings;
		this.requestRender = options.requestRender;
		this.done = options.done;
		this.maxLineWidth = Math.max(
			0,
			...this.lines.map((line) => visibleWidth(line)),
		);
	}

	private maxVerticalOffset(): number {
		return Math.max(0, this.lines.length - PREVIEW_VISIBLE_LINES);
	}

	private maxHorizontalOffset(): number {
		return Math.max(0, this.maxLineWidth - this.codeWidth);
	}

	private scrollVertical(delta: number): void {
		this.verticalOffset = Math.max(
			0,
			Math.min(this.maxVerticalOffset(), this.verticalOffset + delta),
		);
		this.requestRender();
	}

	private scrollHorizontal(delta: number): void {
		this.horizontalOffset = Math.max(
			0,
			Math.min(this.maxHorizontalOffset(), this.horizontalOffset + delta),
		);
		this.requestRender();
	}

	handleInput(data: string): void {
		if (this.keybindings.matches(data, "tui.select.cancel")) {
			this.done(false);
			return;
		}
		if (this.keybindings.matches(data, "tui.select.confirm")) {
			this.done(true);
			return;
		}
		if (this.keybindings.matches(data, "tui.select.up")) {
			this.scrollVertical(-1);
			return;
		}
		if (this.keybindings.matches(data, "tui.select.down")) {
			this.scrollVertical(1);
			return;
		}
		if (this.keybindings.matches(data, "tui.select.pageUp")) {
			this.scrollVertical(-PREVIEW_VISIBLE_LINES);
			return;
		}
		if (this.keybindings.matches(data, "tui.select.pageDown")) {
			this.scrollVertical(PREVIEW_VISIBLE_LINES);
			return;
		}
		if (this.keybindings.matches(data, "tui.editor.cursorLeft")) {
			this.scrollHorizontal(-HORIZONTAL_SCROLL_COLUMNS);
			return;
		}
		if (this.keybindings.matches(data, "tui.editor.cursorRight")) {
			this.scrollHorizontal(HORIZONTAL_SCROLL_COLUMNS);
			return;
		}
		if (this.keybindings.matches(data, "tui.editor.cursorLineStart")) {
			this.horizontalOffset = 0;
			this.requestRender();
			return;
		}
		if (this.keybindings.matches(data, "tui.editor.cursorLineEnd")) {
			this.horizontalOffset = this.maxHorizontalOffset();
			this.requestRender();
		}
	}

	private highlightedCacheKey?: string;
	private highlightedCache?: string[];

	private highlight(lines: string[]): string[] {
		try {
			const highlighted = highlightCode(
				lines.join("\n"),
				this.language,
				this.theme,
			).split("\n");
			return lines.map(
				(line, index) =>
					highlighted[index] ?? this.theme.fg("mdCodeBlock", line),
			);
		} catch {
			return lines.map((line) => this.theme.fg("mdCodeBlock", line));
		}
	}

	render(width: number): string[] {
		const innerWidth = Math.max(1, width - 2);
		const lineNumberWidth = String(this.lines.length).length;
		const gutterWidth = lineNumberWidth + 3;
		this.codeWidth = Math.max(1, innerWidth - gutterWidth);
		this.horizontalOffset = Math.min(
			this.horizontalOffset,
			this.maxHorizontalOffset(),
		);

		const lastLine = Math.min(
			this.lines.length,
			this.verticalOffset + PREVIEW_VISIBLE_LINES,
		);
		// The TUI re-renders on every redraw (status updates, timers, resizes);
		// only re-highlight when the visible window actually changed.
		const highlightKey = `${this.verticalOffset}:${this.horizontalOffset}:${this.codeWidth}`;
		if (this.highlightedCacheKey !== highlightKey || !this.highlightedCache) {
			const visibleLines = this.lines
				.slice(this.verticalOffset, lastLine)
				.map((line) =>
					sliceByColumns(line, this.horizontalOffset, this.codeWidth),
				);
			this.highlightedCache = this.highlight(visibleLines);
			this.highlightedCacheKey = highlightKey;
		}
		const highlightedLines = this.highlightedCache;
		const border = (text: string) => this.theme.fg("border", text);
		const row = (content: string) =>
			`${border("│")}${truncateToWidth(content, innerWidth, "", true)}${border("│")}`;
		const separator = `${border("├")}${border("─".repeat(innerWidth))}${border("┤")}`;
		const title = `Copy code · ${this.language} · ${this.lines.length} ${this.lines.length === 1 ? "line" : "lines"}`;
		const horizontalStatus =
			this.maxLineWidth > this.codeWidth
				? ` · columns ${this.horizontalOffset + 1}-${Math.min(
						this.maxLineWidth,
						this.horizontalOffset + this.codeWidth,
					)}/${this.maxLineWidth}`
				: "";
		const output = [
			`${border("╭")}${border("─".repeat(innerWidth))}${border("╮")}`,
			row(` ${this.theme.fg("accent", this.theme.bold(title))}`),
			separator,
			row(
				this.theme.fg(
					"dim",
					` Lines ${this.verticalOffset + 1}-${lastLine}/${this.lines.length}${horizontalStatus}`,
				),
			),
		];

		for (let index = 0; index < highlightedLines.length; index += 1) {
			const lineNumber = String(this.verticalOffset + index + 1).padStart(
				lineNumberWidth,
			);
			const gutter = `${this.theme.fg("dim", lineNumber)} ${this.theme.fg("borderMuted", "│")} `;
			output.push(row(`${gutter}${highlightedLines[index]}`));
		}

		output.push(
			separator,
			row(
				this.theme.fg(
					"dim",
					" ↑↓/PgUp/PgDn scroll · ←→ columns · enter copy · esc cancel",
				),
			),
			`${border("╰")}${border("─".repeat(innerWidth))}${border("╯")}`,
		);
		return output;
	}

	invalidate(): void {}
}

async function copyBlock(
	block: FencedCodeBlock,
	ctx: ExtensionCommandContext,
): Promise<void> {
	try {
		await copyToClipboard(block.content);
		const lineCount = block.content ? block.content.split("\n").length : 0;
		ctx.ui.notify(`Copied code block (${lineCount} logical lines)`, "info");
	} catch (error) {
		ctx.ui.notify(
			error instanceof Error ? error.message : String(error),
			"error",
		);
	}
}

async function previewAndCopy(
	block: FencedCodeBlock,
	ctx: ExtensionCommandContext,
): Promise<void> {
	if (ctx.mode !== "tui") {
		await copyBlock(block, ctx);
		return;
	}

	const confirmed = await ctx.ui.custom<boolean>(
		(tui, theme, keybindings, done) =>
			new CodePreview({
				block,
				theme,
				keybindings,
				requestRender: () => tui.requestRender(),
				done,
			}),
		{
			overlay: true,
			overlayOptions: {
				anchor: "center",
				width: "85%",
				minWidth: 50,
				maxHeight: 20,
				margin: 1,
			},
		},
	);
	if (confirmed) await copyBlock(block, ctx);
}

export default function (pi: ExtensionAPI): void {
	pi.registerCommand("copy-code", {
		description:
			"Preview and copy a code block from the last assistant message",
		handler: async (args, ctx) => {
			const assistantText = lastAssistantText(ctx);
			if (!assistantText) {
				ctx.ui.notify("No assistant message to copy", "warning");
				return;
			}

			const blocks = extractFencedCodeBlocks(assistantText).filter((block) =>
				block.content.trim(),
			);
			if (blocks.length === 0) {
				ctx.ui.notify(
					"The last assistant message has no fenced code blocks. Use Ctrl+X to copy it all.",
					"warning",
				);
				return;
			}

			const requestedIndex = args.trim();
			if (requestedIndex) {
				const blockNumber = Number(requestedIndex);
				if (
					!Number.isInteger(blockNumber) ||
					blockNumber < 1 ||
					blockNumber > blocks.length
				) {
					ctx.ui.notify(
						`Choose a code block from 1 to ${blocks.length}`,
						"warning",
					);
					return;
				}
				await previewAndCopy(blocks[blockNumber - 1], ctx);
				return;
			}

			if (blocks.length === 1) {
				await previewAndCopy(blocks[0], ctx);
				return;
			}

			const labels = blocks.map(blockLabel);
			const selected = await ctx.ui.select("Copy code block", labels);
			if (!selected) return;

			const selectedIndex = labels.indexOf(selected);
			if (selectedIndex >= 0) await previewAndCopy(blocks[selectedIndex], ctx);
		},
	});
}
