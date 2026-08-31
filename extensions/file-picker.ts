import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type {
	ExtensionAPI,
	ExtensionContext,
	KeybindingsManager,
	Theme,
} from "@earendil-works/pi-coding-agent";
import {
	fuzzyFilter,
	Input,
	type Focusable,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";

type PickerMode = "files" | "content";

type PickerResult = {
	path: string;
	line?: number;
	preview?: string;
};

const MAX_FILES = 50_000;
const MAX_RESULTS = 200;
const VISIBLE_RESULTS = 10;
const IGNORED_DIRECTORIES = [
	".git",
	".hg",
	".svn",
	"node_modules",
	"dist",
	"build",
	"coverage",
	".next",
	".turbo",
	"target",
	"vendor",
];

const RG_GLOBS = IGNORED_DIRECTORIES.map((name) => `!**/${name}/**`);

const pathCollator = new Intl.Collator();

function normalizePath(path: string): string {
	return path.replace(/^\.\//, "").replaceAll("\\", "/");
}

function parseFileList(stdout: string): string[] {
	return stdout
		.split("\n")
		.map((path) => normalizePath(path.trim()))
		.filter(Boolean)
		.slice(0, MAX_FILES)
		.sort(pathCollator.compare);
}

async function listProjectFiles(
	pi: ExtensionAPI,
	cwd: string,
): Promise<string[]> {
	const rgArgs = ["--files", "--hidden"];
	for (const glob of RG_GLOBS) rgArgs.push("--glob", glob);

	const rg = await pi.exec("rg", rgArgs, { cwd, timeout: 10_000 });
	if (rg.code === 0) return parseFileList(rg.stdout);

	const git = await pi.exec(
		"git",
		["ls-files", "--cached", "--others", "--exclude-standard"],
		{
			cwd,
			timeout: 10_000,
		},
	);
	if (git.code === 0) return parseFileList(git.stdout);

	return [];
}

function parseRipgrepMatch(rawLine: string): PickerResult | undefined {
	if (!rawLine) return undefined;

	try {
		const event = JSON.parse(rawLine) as {
			type?: string;
			data?: {
				path?: { text?: string };
				lines?: { text?: string };
				line_number?: number;
			};
		};
		if (event.type !== "match") return undefined;

		const path = event.data?.path?.text;
		const line = event.data?.line_number;
		if (!path || !line) return undefined;

		return {
			path: normalizePath(path),
			line,
			preview: (event.data?.lines?.text ?? "").replace(/[\r\n]+/g, " ").trim(),
		};
	} catch {
		return undefined;
	}
}

function ripgrepArgs(query: string): string[] {
	const args = [
		"--json",
		"--fixed-strings",
		"--smart-case",
		"--hidden",
		"--max-count",
		"3",
		"--max-filesize",
		"1M",
	];
	for (const glob of RG_GLOBS) args.push("--glob", glob);
	args.push("--", query, ".");
	return args;
}

class RipgrepSearch {
	readonly completion: Promise<PickerResult[]>;

	private readonly child: ChildProcessWithoutNullStreams;
	private readonly signal: AbortSignal;
	private readonly onResults: (results: PickerResult[]) => void;
	private readonly results: PickerResult[] = [];
	private readonly seen = new Set<string>();
	private resolveSearch: (results: PickerResult[]) => void = () => {};
	private rejectSearch: (reason: unknown) => void = () => {};
	private stdoutBuffer = "";
	private stderr = "";
	private reachedLimit = false;
	private settled = false;

	constructor(
		cwd: string,
		query: string,
		signal: AbortSignal,
		onResults: (results: PickerResult[]) => void,
	) {
		this.signal = signal;
		this.onResults = onResults;
		this.completion = new Promise((resolve, reject) => {
			this.resolveSearch = resolve;
			this.rejectSearch = reject;
		});
		this.child = spawn("rg", ripgrepArgs(query), { cwd, stdio: "pipe" });
		this.child.stdin.end();
		this.bindSignal();
		this.bindOutput();
		this.bindLifecycle();
	}

	private readonly abort = (): void => {
		this.child.kill("SIGTERM");
	};

	private bindSignal(): void {
		this.signal.addEventListener("abort", this.abort, { once: true });
		if (this.signal.aborted) this.abort();
	}

	private bindOutput(): void {
		this.child.stdout.setEncoding("utf8");
		this.child.stdout.on("data", (chunk: string) => this.handleStdout(chunk));
		this.child.stderr.setEncoding("utf8");
		this.child.stderr.on("data", (chunk: string) => this.handleStderr(chunk));
	}

	private bindLifecycle(): void {
		this.child.once("error", (error) => this.handleError(error));
		this.child.once("close", (code) => this.handleClose(code));
	}

	private handleStdout(chunk: string): void {
		this.stdoutBuffer += chunk;
		const lines = this.stdoutBuffer.split("\n");
		this.stdoutBuffer = lines.pop() ?? "";
		this.publishLines(lines);
	}

	private handleStderr(chunk: string): void {
		if (this.stderr.length < 4_000) this.stderr += chunk;
	}

	private publishLines(lines: string[]): void {
		if (this.reachedLimit) return;
		let changed = false;
		for (const line of lines) {
			changed = this.addMatch(line) || changed;
			if (this.reachedLimit) break;
		}
		if (changed) this.onResults([...this.results]);
	}

	private addMatch(line: string): boolean {
		const match = parseRipgrepMatch(line);
		if (!match) return false;
		const key = `${match.path}:${match.line}`;
		if (this.seen.has(key)) return false;
		this.seen.add(key);
		this.results.push(match);
		if (this.results.length >= MAX_RESULTS) {
			this.reachedLimit = true;
			this.abort();
		}
		return true;
	}

	private beginSettlement(): boolean {
		if (this.settled) return false;
		this.settled = true;
		this.signal.removeEventListener("abort", this.abort);
		return true;
	}

	private handleError(error: Error): void {
		if (!this.beginSettlement()) return;
		this.rejectSearch(error);
	}

	private handleClose(code: number | null): void {
		if (!this.beginSettlement()) return;
		if (this.stdoutBuffer) this.publishLines([this.stdoutBuffer]);
		if (this.signal.aborted) {
			this.resolveSearch([]);
			return;
		}
		if (code === 0 || code === 1 || this.reachedLimit) {
			this.resolveSearch(this.results);
			return;
		}
		const message =
			this.stderr.trim() || `ripgrep exited with code ${code ?? "unknown"}`;
		this.rejectSearch(new Error(message));
	}
}

type PickerRenderState = {
	mode: PickerMode;
	results: PickerResult[];
	selectedIndex: number;
	searching: boolean;
	error?: string;
};

function pickerRow(theme: Theme, content: string, innerWidth: number): string {
	const fitted = truncateToWidth(content, innerWidth, "…");
	const padding = " ".repeat(Math.max(0, innerWidth - visibleWidth(fitted)));
	return `${theme.fg("border", "│")}${fitted}${padding}${theme.fg("border", "│")}`;
}

function renderPickerHeader(
	theme: Theme,
	input: Input,
	mode: PickerMode,
	innerWidth: number,
): string[] {
	const filesTab =
		mode === "files"
			? theme.fg("accent", theme.bold("Files"))
			: theme.fg("dim", "Files");
	const contentTab =
		mode === "content"
			? theme.fg("accent", theme.bold("Content"))
			: theme.fg("dim", "Content");
	const inputLine = input.render(Math.max(1, innerWidth - 3))[0] ?? "";
	return [
		pickerRow(
			theme,
			` ${filesTab}${theme.fg("dim", "  |  ")}${contentTab}`,
			innerWidth,
		),
		pickerRow(theme, ` ${theme.fg("accent", "›")} ${inputLine}`, innerWidth),
		pickerRow(
			theme,
			theme.fg("dim", ` ${"─".repeat(Math.max(0, innerWidth - 2))} `),
			innerWidth,
		),
	];
}

function renderPickerEmpty(
	theme: Theme,
	input: Input,
	state: PickerRenderState,
	innerWidth: number,
): string {
	if (state.error) {
		return pickerRow(theme, ` ${theme.fg("error", state.error)}`, innerWidth);
	}
	if (state.searching) {
		return pickerRow(
			theme,
			` ${theme.fg("warning", "Searching file contents…")}`,
			innerWidth,
		);
	}
	const message =
		state.mode === "content" && !input.getValue().trim()
			? "Type to search file contents"
			: "No matches";
	return pickerRow(theme, ` ${theme.fg("muted", message)}`, innerWidth);
}

function renderPickerResult(options: {
	theme: Theme;
	result: PickerResult;
	index: number;
	state: PickerRenderState;
	innerWidth: number;
}): string {
	const { theme, result, index, state, innerWidth } = options;
	const selected = index === state.selectedIndex;
	const marker = selected ? theme.fg("accent", "›") : " ";
	const location = result.line ? `${result.path}:${result.line}` : result.path;
	let content = ` ${marker} ${location}`;
	if (result.preview) content += theme.fg("dim", `  ${result.preview}`);
	if (selected) content = theme.bg("selectedBg", content);
	return pickerRow(theme, content, innerWidth);
}

function renderPickerResults(
	theme: Theme,
	state: PickerRenderState,
	innerWidth: number,
): string[] {
	const start = Math.max(
		0,
		Math.min(
			state.selectedIndex - Math.floor(VISIBLE_RESULTS / 2),
			state.results.length - VISIBLE_RESULTS,
		),
	);
	const visible = state.results.slice(start, start + VISIBLE_RESULTS);
	const lines = visible.map((result, offset) =>
		renderPickerResult({
			theme,
			result,
			index: start + offset,
			state,
			innerWidth,
		}),
	);
	if (state.results.length <= VISIBLE_RESULTS && !state.searching) return lines;

	let status = ` searching… · ${state.results.length} results`;
	if (!state.searching) {
		const limitMarker = state.results.length === MAX_RESULTS ? "+" : "";
		status = ` ${state.selectedIndex + 1}/${state.results.length}${limitMarker}`;
	}
	lines.push(pickerRow(theme, theme.fg("dim", status), innerWidth));
	return lines;
}

function renderPicker(
	theme: Theme,
	input: Input,
	state: PickerRenderState,
	width: number,
): string[] {
	const innerWidth = Math.max(0, width - 2);
	const border = theme.fg("border", "─".repeat(innerWidth));
	const lines = [
		`${theme.fg("border", "╭")}${border}${theme.fg("border", "╮")}`,
		...renderPickerHeader(theme, input, state.mode, innerWidth),
	];
	if (state.error || state.results.length === 0) {
		lines.push(renderPickerEmpty(theme, input, state, innerWidth));
	} else {
		lines.push(...renderPickerResults(theme, state, innerWidth));
	}
	lines.push(
		pickerRow(
			theme,
			theme.fg("dim", " ↑↓ navigate · tab mode · enter insert · esc cancel"),
			innerWidth,
		),
		`${theme.fg("border", "╰")}${border}${theme.fg("border", "╯")}`,
	);
	return lines;
}

class FilePicker implements Focusable {
	private readonly input = new Input();
	private readonly files: string[];
	private readonly theme: Theme;
	private readonly keybindings: KeybindingsManager;
	private readonly requestRender: () => void;
	private readonly done: (result: PickerResult | null) => void;
	private readonly cwd: string;

	private mode: PickerMode = "files";
	private results: PickerResult[] = [];
	private selectedIndex = 0;
	private searching = false;
	private error?: string;
	private searchTimer?: ReturnType<typeof setTimeout>;
	private searchAbort?: AbortController;
	private searchGeneration = 0;
	private _focused = false;

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.input.focused = value;
	}

	constructor(options: {
		files: string[];
		theme: Theme;
		keybindings: KeybindingsManager;
		requestRender: () => void;
		done: (result: PickerResult | null) => void;
		cwd: string;
	}) {
		this.files = options.files;
		this.theme = options.theme;
		this.keybindings = options.keybindings;
		this.requestRender = options.requestRender;
		this.done = options.done;
		this.cwd = options.cwd;
		this.refreshResults();
	}

	private refreshResults(): void {
		this.selectedIndex = 0;
		this.error = undefined;

		if (this.mode === "files") {
			this.cancelContentSearch();
			const query = this.input.getValue().trim();
			const matches = query
				? fuzzyFilter(this.files, query, (path) => path)
				: this.files;
			this.results = matches.slice(0, MAX_RESULTS).map((path) => ({ path }));
			this.searching = false;
			this.requestRender();
			return;
		}

		this.queueContentSearch();
	}

	private queueContentSearch(): void {
		this.cancelContentSearch();
		this.results = [];
		this.error = undefined;

		const query = this.input.getValue().trim();
		if (!query) {
			this.searching = false;
			this.requestRender();
			return;
		}

		this.searching = true;
		const generation = ++this.searchGeneration;
		const controller = new AbortController();
		this.searchAbort = controller;
		this.searchTimer = setTimeout(() => {
			const search = new RipgrepSearch(
				this.cwd,
				query,
				controller.signal,
				(results) => {
					if (controller.signal.aborted || generation !== this.searchGeneration)
						return;
					this.results = results;
					this.selectedIndex = Math.min(
						this.selectedIndex,
						Math.max(0, results.length - 1),
					);
					this.requestRender();
				},
			);
			void search.completion
				.then((results) => {
					if (controller.signal.aborted || generation !== this.searchGeneration)
						return;
					this.results = results;
					this.searching = false;
					this.selectedIndex = Math.min(
						this.selectedIndex,
						Math.max(0, results.length - 1),
					);
					this.requestRender();
				})
				.catch((error: unknown) => {
					if (controller.signal.aborted || generation !== this.searchGeneration)
						return;
					this.results = [];
					this.searching = false;
					this.error = error instanceof Error ? error.message : String(error);
					this.requestRender();
				});
		}, 40);
		this.requestRender();
	}

	private cancelContentSearch(): void {
		if (this.searchTimer) clearTimeout(this.searchTimer);
		this.searchTimer = undefined;
		this.searchAbort?.abort();
		this.searchAbort = undefined;
		this.searchGeneration++;
	}

	private moveSelection(delta: number): void {
		if (this.results.length === 0) return;
		this.selectedIndex = Math.max(
			0,
			Math.min(this.results.length - 1, this.selectedIndex + delta),
		);
	}

	handleInput(data: string): void {
		if (this.keybindings.matches(data, "tui.select.cancel")) {
			this.done(null);
			return;
		}
		if (this.keybindings.matches(data, "tui.input.tab")) {
			this.mode = this.mode === "files" ? "content" : "files";
			this.refreshResults();
			return;
		}
		if (this.keybindings.matches(data, "tui.select.up")) {
			this.moveSelection(-1);
			this.requestRender();
			return;
		}
		if (this.keybindings.matches(data, "tui.select.down")) {
			this.moveSelection(1);
			this.requestRender();
			return;
		}
		if (this.keybindings.matches(data, "tui.select.pageUp")) {
			this.moveSelection(-VISIBLE_RESULTS);
			this.requestRender();
			return;
		}
		if (this.keybindings.matches(data, "tui.select.pageDown")) {
			this.moveSelection(VISIBLE_RESULTS);
			this.requestRender();
			return;
		}
		if (this.keybindings.matches(data, "tui.select.confirm")) {
			const selected = this.results[this.selectedIndex];
			if (selected) this.done(selected);
			return;
		}

		const previousQuery = this.input.getValue();
		this.input.handleInput(data);
		if (this.input.getValue() !== previousQuery) this.refreshResults();
		else this.requestRender();
	}

	render(width: number): string[] {
		const state: PickerRenderState = {
			mode: this.mode,
			results: this.results,
			selectedIndex: this.selectedIndex,
			searching: this.searching,
			error: this.error,
		};
		return renderPicker(this.theme, this.input, state, width);
	}

	invalidate(): void {
		this.input.invalidate();
	}

	dispose(): void {
		this.cancelContentSearch();
	}
}

async function openPicker(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
): Promise<void> {
	if (ctx.mode !== "tui") return;

	const files = await listProjectFiles(pi, ctx.cwd);
	if (files.length === 0) {
		ctx.ui.notify("File picker: no project files found", "warning");
		return;
	}

	const result = await ctx.ui.custom<PickerResult | null>(
		(tui, theme, keybindings, done) =>
			new FilePicker({
				files,
				theme,
				keybindings,
				requestRender: () => tui.requestRender(),
				done,
				cwd: ctx.cwd,
			}),
		{
			overlay: true,
			overlayOptions: {
				anchor: "center",
				width: "75%",
				minWidth: 50,
				maxHeight: 18,
				margin: 1,
			},
		},
	);

	if (result) ctx.ui.pasteToEditor(`@${result.path} `);
}

export default function (pi: ExtensionAPI): void {
	pi.registerShortcut("ctrl+f", {
		description: "Open Telescope-style file picker",
		handler: async (ctx) => openPicker(pi, ctx),
	});

	pi.registerCommand("files", {
		description: "Open Telescope-style file picker",
		handler: async (_args, ctx) => openPicker(pi, ctx),
	});
}
