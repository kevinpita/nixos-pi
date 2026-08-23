/// <reference path="./runtime.d.ts" />

import type {
	ExtensionAPI,
	ExtensionContext,
	KeybindingsManager,
	Theme,
} from "@earendil-works/pi-coding-agent"; // pi-lens-ignore: find-import-file-without-extension
import {
	type AutocompleteItem,
	type AutocompleteProvider,
	type AutocompleteSuggestions,
	type Focusable,
	Input,
	matchesKey,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui"; // pi-lens-ignore: find-import-file-without-extension
import {
	extractGitReferenceToken,
	filterGitReferences,
	formatGitReference,
	type GitBranch,
	type GitPullRequest,
	type GitReference,
	parseBranchRefs,
	parsePullRequests,
} from "./core.ts";

const BRANCH_FORMAT = [
	"%(refname)",
	"%(refname:short)",
	"%(HEAD)",
	"%(upstream:short)",
	"%(worktreepath)",
	"%(committerdate:unix)",
	"%(objectname:short)",
	"%(subject)",
].join("%09");
const MAX_PULL_REQUESTS = 100;
const MAX_AUTOCOMPLETE_ITEMS = 20;
const MAX_PICKER_RESULTS = 200;
const VISIBLE_RESULTS = 10;

type PickerMode = "branches" | "pullRequests";

type CommandResult = {
	code: number;
	stdout: string;
	stderr: string;
};

function commandError(label: string, result: CommandResult): string {
	const detail = result.stderr.trim().split("\n")[0];
	return detail ? `${label}: ${detail}` : `${label}: exit code ${result.code}`;
}

function unknownError(label: string, error: unknown): string {
	const detail = error instanceof Error ? error.message : String(error);
	return `${label}: ${detail}`;
}

class GitReferenceStore {
	readonly cwd: string;
	private readonly pi: ExtensionAPI;
	private branches: GitBranch[] = [];
	private pullRequests?: GitPullRequest[];
	private pullRequestPromise?: Promise<void>;
	private branchesLoaded = false;
	private branchError?: string;
	private pullRequestError?: string;

	constructor(pi: ExtensionAPI, cwd: string) {
		this.pi = pi;
		this.cwd = cwd;
	}

	getBranches(): readonly GitBranch[] {
		return this.branches;
	}

	getPullRequests(): readonly GitPullRequest[] | undefined {
		return this.pullRequests;
	}

	getBranchError(): string | undefined {
		return this.branchError;
	}

	getPullRequestError(): string | undefined {
		return this.pullRequestError;
	}

	isGitRepository(): boolean {
		return this.branchesLoaded && this.branchError === undefined;
	}

	async loadBranches(force = false): Promise<void> {
		if (this.branchesLoaded && !force) return;
		try {
			const result = await this.pi.exec(
				"git",
				[
					"for-each-ref",
					"--sort=-committerdate",
					`--format=${BRANCH_FORMAT}`,
					"refs/heads",
					"refs/remotes",
				],
				{ cwd: this.cwd, timeout: 5_000 },
			);
			this.branchesLoaded = true;
			if (result.code !== 0) {
				this.branches = [];
				this.branchError = commandError("Cannot load Git branches", result);
				return;
			}
			this.branches = parseBranchRefs(result.stdout);
			this.branchError = undefined;
		} catch (error) {
			this.branchesLoaded = true;
			this.branches = [];
			this.branchError = unknownError("Cannot load Git branches", error);
		}
	}

	async loadPullRequests(force = false): Promise<void> {
		if (this.pullRequestPromise) return this.pullRequestPromise;
		if (this.pullRequests !== undefined && !force) return;
		if (force) this.pullRequests = undefined;

		this.pullRequestPromise = (async () => {
			try {
				const result = await this.pi.exec(
					"gh",
					[
						"pr",
						"list",
						"--state",
						"open",
						"--limit",
						String(MAX_PULL_REQUESTS),
						"--json",
						"number,title,state,isDraft,headRefName,baseRefName,updatedAt,url,author",
					],
					{ cwd: this.cwd, timeout: 10_000 },
				);
				if (result.code !== 0) {
					this.pullRequests = undefined;
					this.pullRequestError = commandError(
						"Cannot load GitHub pull requests",
						result,
					);
					return;
				}
				this.pullRequests = parsePullRequests(result.stdout);
				this.pullRequestError = undefined;
			} catch (error) {
				this.pullRequests = undefined;
				this.pullRequestError = unknownError(
					"Cannot load GitHub pull requests",
					error,
				);
			}
		})().finally(() => {
			this.pullRequestPromise = undefined;
		});

		return this.pullRequestPromise;
	}
}

function formatBranchDescription(branch: GitBranch): string {
	const source = branch.current ? "current" : branch.local ? "local" : "remote";
	return `[${source}] ${branch.commit}${branch.subject ? ` ${branch.subject}` : ""}`;
}

function formatPullRequestDescription(pullRequest: GitPullRequest): string {
	const state = pullRequest.isDraft
		? "draft"
		: pullRequest.state.toLowerCase() || "open";
	const route =
		pullRequest.headRefName || pullRequest.baseRefName
			? ` ${pullRequest.headRefName || "?"} -> ${pullRequest.baseRefName || "?"}`
			: "";
	const author = pullRequest.author ? ` by ${pullRequest.author}` : "";
	return `[${state}] ${pullRequest.title}${route}${author}`;
}

function autocompleteItem(reference: GitReference): AutocompleteItem {
	if (reference.kind === "branch") {
		return {
			value: formatGitReference(reference),
			label: `Branch '${reference.name}'`,
			description: formatBranchDescription(reference),
		};
	}
	return {
		value: formatGitReference(reference),
		label: `PR '#${reference.number}'`,
		description: formatPullRequestDescription(reference),
	};
}

function createAutocompleteProvider(
	current: AutocompleteProvider,
	store: GitReferenceStore,
): AutocompleteProvider {
	return {
		triggerCharacters: [
			...new Set([...(current.triggerCharacters ?? []), "@", ":"]),
		],
		async getSuggestions(
			lines,
			cursorLine,
			cursorCol,
			options,
		): Promise<AutocompleteSuggestions | null> {
			const line = lines[cursorLine] ?? "";
			const token = extractGitReferenceToken(line.slice(0, cursorCol));
			if (!token || !store.isGitRepository()) {
				return current.getSuggestions(lines, cursorLine, cursorCol, options);
			}

			let references: readonly GitReference[];
			if (token.mode === "branches") {
				references = store.getBranches();
			} else if (token.mode === "pullRequests") {
				await store.loadPullRequests();
				if (options.signal.aborted) return null;
				references = store.getPullRequests() ?? [];
			} else {
				void store.loadPullRequests();
				references = [
					...store.getBranches(),
					...(store.getPullRequests() ?? []),
				];
			}

			const items = filterGitReferences(
				references,
				token.query,
				MAX_AUTOCOMPLETE_ITEMS,
			).map(autocompleteItem);
			if (items.length === 0) {
				return current.getSuggestions(lines, cursorLine, cursorCol, options);
			}
			return { prefix: token.prefix, items };
		},

		applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
			return current.applyCompletion(
				lines,
				cursorLine,
				cursorCol,
				item,
				prefix,
			);
		},

		shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
			return (
				current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ??
				true
			);
		},
	};
}

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
	const branchesTab =
		mode === "branches"
			? theme.fg("accent", theme.bold("Branches"))
			: theme.fg("dim", "Branches");
	const pullRequestsTab =
		mode === "pullRequests"
			? theme.fg("accent", theme.bold("Pull requests"))
			: theme.fg("dim", "Pull requests");
	const inputLine = input.render(Math.max(1, innerWidth - 3))[0] ?? "";
	return [
		pickerRow(
			theme,
			` ${branchesTab}${theme.fg("dim", "  |  ")}${pullRequestsTab}`,
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

function pickerReferenceText(theme: Theme, reference: GitReference): string {
	if (reference.kind === "branch") {
		const marker = reference.current ? "*" : reference.local ? "L" : "R";
		const subject = reference.subject ? `  ${reference.subject}` : "";
		return `${theme.fg("muted", marker)} ${reference.name}  ${theme.fg("dim", reference.commit + subject)}`;
	}

	const state = reference.isDraft
		? "draft"
		: reference.state.toLowerCase() || "open";
	const route = `${reference.headRefName || "?"} -> ${reference.baseRefName || "?"}`;
	const author = reference.author ? `  @${reference.author}` : "";
	return `#${reference.number} ${reference.title}  ${theme.fg("dim", `[${state}] ${route}${author}`)}`;
}

type PickerRenderState = {
	mode: PickerMode;
	results: GitReference[];
	selectedIndex: number;
	loading: boolean;
	error?: string;
};

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
	const lines = visible.map((reference, offset) => {
		const selected = start + offset === state.selectedIndex;
		const marker = selected ? theme.fg("accent", "›") : " ";
		let content = ` ${marker} ${pickerReferenceText(theme, reference)}`;
		if (selected) content = theme.bg("selectedBg", content);
		return pickerRow(theme, content, innerWidth);
	});

	if (state.results.length > VISIBLE_RESULTS || state.loading) {
		const position = state.results.length
			? `${state.selectedIndex + 1}/${state.results.length}`
			: "0 results";
		const loading = state.loading ? " · loading…" : "";
		lines.push(
			pickerRow(theme, theme.fg("dim", ` ${position}${loading}`), innerWidth),
		);
	}
	return lines;
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
	if (state.loading) {
		return pickerRow(theme, ` ${theme.fg("warning", "Loading…")}`, innerWidth);
	}
	if (input.getValue().trim()) {
		return pickerRow(theme, ` ${theme.fg("muted", "No matches")}`, innerWidth);
	}
	const message =
		state.mode === "branches"
			? "No Git branches found"
			: "No open pull requests found";
	return pickerRow(theme, ` ${theme.fg("muted", message)}`, innerWidth);
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
			theme.fg(
				"dim",
				" ↑↓ navigate · tab mode · enter insert · ctrl+r refresh · esc cancel",
			),
			innerWidth,
		),
		`${theme.fg("border", "╰")}${border}${theme.fg("border", "╯")}`,
	);
	return lines;
}

class GitReferencePicker implements Focusable {
	private readonly input = new Input();
	private readonly store: GitReferenceStore;
	private readonly theme: Theme;
	private readonly keybindings: KeybindingsManager;
	private readonly requestRender: () => void;
	private readonly done: (reference: GitReference | null) => void;
	private mode: PickerMode;
	private results: GitReference[] = [];
	private selectedIndex = 0;
	private loading = false;
	private error?: string;
	private disposed = false;
	private _focused = false;

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.input.focused = value;
	}

	constructor(options: {
		store: GitReferenceStore;
		theme: Theme;
		keybindings: KeybindingsManager;
		requestRender: () => void;
		done: (reference: GitReference | null) => void;
		initialMode: PickerMode;
	}) {
		this.store = options.store;
		this.theme = options.theme;
		this.keybindings = options.keybindings;
		this.requestRender = options.requestRender;
		this.done = options.done;
		this.mode = options.initialMode;
		this.refreshResults();
		if (this.mode === "pullRequests" && !this.store.getPullRequests()) {
			void this.refreshData(false);
		}
	}

	private sourceReferences(): readonly GitReference[] {
		return this.mode === "branches"
			? this.store.getBranches()
			: (this.store.getPullRequests() ?? []);
	}

	private sourceError(): string | undefined {
		return this.mode === "branches"
			? this.store.getBranchError()
			: this.store.getPullRequestError();
	}

	private refreshResults(): void {
		this.results = filterGitReferences(
			this.sourceReferences(),
			this.input.getValue(),
			MAX_PICKER_RESULTS,
		);
		this.selectedIndex = Math.min(
			this.selectedIndex,
			Math.max(0, this.results.length - 1),
		);
		this.error = this.sourceError();
		this.requestRender();
	}

	private async refreshData(force: boolean): Promise<void> {
		this.loading = true;
		this.error = undefined;
		this.requestRender();
		if (this.mode === "branches") {
			await this.store.loadBranches(force);
		} else {
			await this.store.loadPullRequests(force);
		}
		if (this.disposed) return;
		this.loading = false;
		this.selectedIndex = 0;
		this.refreshResults();
	}

	private switchMode(): void {
		this.mode = this.mode === "branches" ? "pullRequests" : "branches";
		this.selectedIndex = 0;
		this.error = undefined;
		this.refreshResults();
		if (this.mode === "pullRequests" && !this.store.getPullRequests()) {
			void this.refreshData(false);
		}
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
		if (
			this.keybindings.matches(data, "tui.input.tab") ||
			matchesKey(data, "shift+tab")
		) {
			this.switchMode();
			return;
		}
		if (matchesKey(data, "ctrl+r")) {
			void this.refreshData(true);
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
		if (this.input.getValue() !== previousQuery) {
			this.selectedIndex = 0;
			this.refreshResults();
		} else {
			this.requestRender();
		}
	}

	render(width: number): string[] {
		return renderPicker(
			this.theme,
			this.input,
			{
				mode: this.mode,
				results: this.results,
				selectedIndex: this.selectedIndex,
				loading: this.loading,
				error: this.error,
			},
			width,
		);
	}

	invalidate(): void {
		this.input.invalidate();
	}

	dispose(): void {
		this.disposed = true;
	}
}

function requestedMode(args: string): PickerMode {
	return args.trim().toLowerCase().startsWith("pr")
		? "pullRequests"
		: "branches";
}

async function openPicker(
	store: GitReferenceStore,
	ctx: ExtensionContext,
	args: string,
): Promise<void> {
	if (ctx.mode !== "tui") return;
	await store.loadBranches();
	if (!store.isGitRepository()) {
		ctx.ui.notify(
			store.getBranchError() ?? "Current directory is not a Git repository",
			"error",
		);
		return;
	}

	const result = await ctx.ui.custom<GitReference | null>(
		(tui, theme, keybindings, done) =>
			new GitReferencePicker({
				store,
				theme,
				keybindings,
				requestRender: () => tui.requestRender(),
				done,
				initialMode: requestedMode(args),
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

	if (result) ctx.ui.pasteToEditor(`${formatGitReference(result)} `);
}

export default function gitReferencePickerExtension(pi: ExtensionAPI): void {
	let store: GitReferenceStore | undefined;

	const ensureStore = (ctx: ExtensionContext): GitReferenceStore => {
		if (!store || store.cwd !== ctx.cwd) {
			store = new GitReferenceStore(pi, ctx.cwd);
		}
		return store;
	};

	pi.on("session_start", (_event, ctx) => {
		// Register the provider right away and load branches in the background;
		// getSuggestions falls back to the wrapped provider until the load lands.
		const sessionStore = ensureStore(ctx);
		void sessionStore.loadBranches();
		if (ctx.mode === "tui") {
			ctx.ui.addAutocompleteProvider((current) =>
				createAutocompleteProvider(current, sessionStore),
			);
		}
	});

	pi.registerCommand("git-ref", {
		description: "Insert a Git branch or GitHub pull-request reference",
		handler: async (args, ctx) => openPicker(ensureStore(ctx), ctx, args),
	});
}
