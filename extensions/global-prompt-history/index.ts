/// <reference path="./runtime.d.ts" />

import { basename, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
	fuzzyFilter,
	Input,
	Key,
	matchesKey,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import {
	buildBoundedHistory,
	isCwdExcluded,
	promptsFromSessionEntries,
	searchablePromptText,
	singleLinePrompt,
	type PromptRecord,
	type SearchablePrompt,
	trimPromptRecords,
	type SessionDescriptor,
} from "./history.ts";
import {
	discoverSessionFiles,
	parseHistorySessionFile,
	readSessionFileMetadata,
	type SessionFileMetadata,
} from "./session-files.ts";
import {
	historyPaths,
	ignoreSession,
	includeSession,
	listIgnoredSessions,
	loadHistoryConfig,
	type HistoryConfig,
	type IgnoredSession,
} from "./storage.ts";

const LOAD_CONCURRENCY = 4;
const MAX_VISIBLE_RESULTS = 7;
const MIN_CACHE_BYTES = 32 * 1024 * 1024;
const MAX_CACHE_BYTES = 128 * 1024 * 1024;

type Theme = {
	fg(color: string, text: string): string;
	bg(color: string, text: string): string;
	bold(text: string): string;
};

type Keybindings = {
	matches(data: string, keybinding: string): boolean;
};

type Tui = {
	requestRender(): void;
};

type SessionManagerLike = {
	getEntries(): readonly unknown[];
	getSessionFile(): string | undefined;
	getSessionId(): string;
	getSessionName(): string | undefined;
	getSessionDir(): string;
	usesDefaultSessionDir?(): boolean;
};

type HistoryUi = {
	custom<T>(
		factory: (
			tui: Tui,
			theme: Theme,
			keybindings: Keybindings,
			done: (result: T) => void,
		) => HistoryPicker,
		options?: {
			readonly overlay?: boolean;
			readonly overlayOptions?: Record<string, unknown>;
		},
	): Promise<T | undefined>;
	confirm(title: string, message: string): Promise<boolean>;
	select(title: string, options: string[]): Promise<string | undefined>;
	notify(message: string, level?: "info" | "warning" | "error"): void;
	getEditorText(): string;
	setEditorText(text: string): void;
	setStatus(id: string, text: string | undefined): void;
};

type HistoryContext = {
	readonly mode: "tui" | "rpc" | "json" | "print";
	readonly hasUI: boolean;
	readonly cwd: string;
	readonly ui: HistoryUi;
	readonly sessionManager: SessionManagerLike;
};

type HistoryApi = {
	registerShortcut(
		shortcut: string,
		options: {
			readonly description: string;
			readonly handler: (ctx: HistoryContext) => void | Promise<void>;
		},
	): void;
	registerCommand(
		name: string,
		options: {
			readonly description: string;
			readonly handler: (
				args: string,
				ctx: HistoryContext,
			) => void | Promise<void>;
		},
	): void;
};

type CachedSession = {
	readonly fingerprint: string;
	readonly prompts: PromptRecord[];
	readonly malformedLines: number;
	readonly skippedOversizedPrompts: number;
	readonly droppedPrompts: number;
	readonly promptBytes: number;
};

type PromptIndex = {
	readonly prompts: SearchablePrompt[];
	readonly promptBytes: number;
	readonly droppedPrompts: number;
	readonly malformedSessions: number;
	readonly skippedOversizedPrompts: number;
	readonly ignoredSessionCount: number;
	readonly excludedCwdCount: number;
	readonly scannedSessionCount: number;
};

type PickerAction =
	| { readonly kind: "restore"; readonly prompt: SearchablePrompt }
	| {
			readonly kind: "ignore";
			readonly prompt: SearchablePrompt;
			readonly query: string;
	  };

function sessionRoot(ctx: HistoryContext): string {
	if (ctx.sessionManager.usesDefaultSessionDir?.() === false) {
		return ctx.sessionManager.getSessionDir();
	}
	return join(getAgentDir(), "sessions");
}

function activeSessionDescriptor(
	ctx: HistoryContext,
	sessions: readonly SessionFileMetadata[],
): SessionDescriptor | undefined {
	const activePath = ctx.sessionManager.getSessionFile();
	if (!activePath) return undefined;
	const listed = sessions.find(
		(session) => session.descriptor.path === activePath,
	)?.descriptor;
	return {
		id: ctx.sessionManager.getSessionId(),
		path: activePath,
		cwd: listed?.cwd ?? ctx.cwd,
		name: ctx.sessionManager.getSessionName() ?? listed?.name,
		modifiedMs: listed?.modifiedMs ?? Date.now(),
	};
}

function cacheLimit(config: HistoryConfig): number {
	return Math.min(
		MAX_CACHE_BYTES,
		Math.max(MIN_CACHE_BYTES, config.maxBytes * 2),
	);
}

async function readMetadataBatches(
	paths: readonly string[],
	output: SessionFileMetadata[],
): Promise<number> {
	let failed = 0;
	for (let start = 0; start < paths.length; start += LOAD_CONCURRENCY * 4) {
		const batch = paths.slice(start, start + LOAD_CONCURRENCY * 4);
		const results = await Promise.all(
			batch.map(async (path) => {
				try {
					return await readSessionFileMetadata(path);
				} catch {
					return undefined;
				}
			}),
		);
		for (const result of results) {
			if (result) output.push(result);
			else failed += 1;
		}
	}
	return failed;
}

async function discoverSessionMetadata(
	ctx: HistoryContext,
): Promise<{ sessions: SessionFileMetadata[]; failed: number }> {
	const paths = await discoverSessionFiles(sessionRoot(ctx));
	const activePath = ctx.sessionManager.getSessionFile();
	if (activePath && !paths.includes(activePath)) paths.push(activePath);
	const sessions: SessionFileMetadata[] = [];
	const failed = await readMetadataBatches(paths, sessions);
	return { sessions, failed };
}

type SessionCollection = {
	records: PromptRecord[];
	malformedSessions: number;
	skippedOversizedPrompts: number;
	droppedPrompts: number;
};

function createPromptIndexer(): {
	build(ctx: HistoryContext): Promise<PromptIndex>;
	clearSession(sessionId: string): void;
} {
	const cache = new Map<string, CachedSession>();
	let cacheBytes = 0;
	let activeBuild: Promise<PromptIndex> | undefined;

	function removeCached(path: string): void {
		const existing = cache.get(path);
		if (!existing) return;
		cacheBytes -= existing.promptBytes;
		cache.delete(path);
	}

	function enforceCacheLimit(maximumCacheBytes: number): void {
		while (cacheBytes > maximumCacheBytes) {
			const oldestPath = cache.keys().next().value as string | undefined;
			if (!oldestPath) return;
			removeCached(oldestPath);
		}
	}

	function remember(
		path: string,
		entry: CachedSession,
		maximumCacheBytes: number,
	): void {
		removeCached(path);
		if (entry.promptBytes > maximumCacheBytes) return;
		cache.set(path, entry);
		cacheBytes += entry.promptBytes;
		enforceCacheLimit(maximumCacheBytes);
	}

	async function loadSession(
		metadata: SessionFileMetadata,
		config: HistoryConfig,
	): Promise<CachedSession> {
		const fingerprint = [
			metadata.fingerprint,
			config.maxPromptBytes,
			config.maxPrompts,
			config.maxBytes,
		].join(":");
		const path = metadata.descriptor.path;
		const cached = cache.get(path);
		if (cached?.fingerprint === fingerprint) {
			cache.delete(path);
			cache.set(path, cached);
			return cached;
		}

		const parsed = await parseHistorySessionFile(metadata, {
			maxPromptBytes: config.maxPromptBytes,
			maxPrompts: config.maxPrompts * 2,
			maxBytes: config.maxBytes * 2,
		});
		const loaded: CachedSession = { fingerprint, ...parsed };
		remember(path, loaded, cacheLimit(config));
		return loaded;
	}

	async function collectSessionBatches(
		sessions: readonly SessionFileMetadata[],
		config: HistoryConfig,
		collection: SessionCollection,
	): Promise<void> {
		for (let start = 0; start < sessions.length; start += LOAD_CONCURRENCY) {
			const batch = sessions.slice(start, start + LOAD_CONCURRENCY);
			const results = await Promise.all(
				batch.map(async (session) => {
					try {
						return await loadSession(session, config);
					} catch {
						return undefined;
					}
				}),
			);
			for (const result of results) {
				if (!result) {
					collection.malformedSessions += 1;
					continue;
				}
				if (result.malformedLines > 0) collection.malformedSessions += 1;
				collection.skippedOversizedPrompts += result.skippedOversizedPrompts;
				collection.droppedPrompts += result.droppedPrompts;
				collection.records.push(...result.prompts);
			}
			// Trimming copies and sorts the whole accumulation, so only do it
			// once the slack fills up; buildFresh applies the exact bounds at
			// the end regardless.
			if (collection.records.length > config.maxPrompts * 4) {
				const candidates = trimPromptRecords(collection.records, {
					maxPrompts: config.maxPrompts * 2,
					maxBytes: config.maxBytes * 2,
				});
				collection.records = candidates.records;
				collection.droppedPrompts += candidates.droppedPrompts;
			}
		}
	}

	function applyExclusions(
		sessions: readonly SessionFileMetadata[],
		ignoredIds: ReadonlySet<string>,
		config: HistoryConfig,
	): { sessions: SessionFileMetadata[]; excludedCwdCount: number } {
		const included: SessionFileMetadata[] = [];
		let excludedCwdCount = 0;
		for (const session of sessions) {
			const descriptor = session.descriptor;
			const cwdExcluded = isCwdExcluded(
				descriptor.cwd,
				config.excludedCwdPrefixes,
			);
			if (ignoredIds.has(descriptor.id) || cwdExcluded) {
				removeCached(descriptor.path);
				if (cwdExcluded) excludedCwdCount += 1;
				continue;
			}
			included.push(session);
		}
		return { sessions: included, excludedCwdCount };
	}

	async function buildFresh(ctx: HistoryContext): Promise<PromptIndex> {
		const paths = historyPaths(getAgentDir());
		const [config, ignoredSessions, discovered] = await Promise.all([
			loadHistoryConfig(paths.configPath),
			listIgnoredSessions(paths.stateDir),
			discoverSessionMetadata(ctx),
		]);
		enforceCacheLimit(cacheLimit(config));
		const discoveredPaths = new Set(
			discovered.sessions.map((session) => session.descriptor.path),
		);
		for (const path of cache.keys()) {
			if (!discoveredPaths.has(path)) removeCached(path);
		}

		const ignoredIds = new Set(
			ignoredSessions.map((session) => session.sessionId),
		);
		const filtered = applyExclusions(discovered.sessions, ignoredIds, config);
		const sessions = filtered.sessions.sort(
			(left, right) => right.descriptor.modifiedMs - left.descriptor.modifiedMs,
		);
		const collection: SessionCollection = {
			records: [],
			malformedSessions: discovered.failed,
			skippedOversizedPrompts: 0,
			droppedPrompts: 0,
		};
		await collectSessionBatches(sessions, config, collection);

		const active = activeSessionDescriptor(ctx, discovered.sessions);
		if (
			active &&
			!ignoredIds.has(active.id) &&
			!isCwdExcluded(active.cwd, config.excludedCwdPrefixes)
		) {
			const live = promptsFromSessionEntries(
				ctx.sessionManager.getEntries(),
				active,
				config.maxPromptBytes,
				{
					maxPrompts: config.maxPrompts * 2,
					maxBytes: config.maxBytes * 2,
				},
			);
			collection.records = collection.records.filter(
				(record) => record.sessionPath !== active.path,
			);
			collection.records.push(...live.prompts);
			collection.skippedOversizedPrompts += live.skippedOversizedPrompts;
			collection.droppedPrompts += live.droppedPrompts;
		}

		const candidates = trimPromptRecords(collection.records, {
			maxPrompts: config.maxPrompts * 2,
			maxBytes: config.maxBytes * 2,
		});
		const bounded = buildBoundedHistory(candidates.records, {
			maxPrompts: config.maxPrompts,
			maxBytes: config.maxBytes,
		});
		return {
			...bounded,
			droppedPrompts:
				bounded.droppedPrompts +
				candidates.droppedPrompts +
				collection.droppedPrompts,
			malformedSessions: collection.malformedSessions,
			skippedOversizedPrompts: collection.skippedOversizedPrompts,
			ignoredSessionCount: ignoredSessions.length,
			excludedCwdCount: filtered.excludedCwdCount,
			scannedSessionCount: sessions.length,
		};
	}

	return {
		build(ctx) {
			if (activeBuild) return activeBuild;
			activeBuild = buildFresh(ctx).finally(() => {
				activeBuild = undefined;
			});
			return activeBuild;
		},
		clearSession(sessionId) {
			for (const [path, entry] of cache) {
				if (entry.prompts.some((prompt) => prompt.sessionId === sessionId)) {
					removeCached(path);
				}
			}
		},
	};
}

function shortenHome(path: string): string {
	const home = process.env.HOME;
	return home && path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

function formatDate(timestampMs: number): string {
	return new Date(timestampMs).toLocaleString(undefined, {
		year: "numeric",
		month: "short",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
	});
}

function formatBytes(bytes: number): string {
	if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KiB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function resultMetadata(prompt: SearchablePrompt): string {
	const file = basename(prompt.sessionPath, ".jsonl");
	const session = prompt.sessionName?.trim()
		? `${prompt.sessionName.trim()} · ${file}`
		: file;
	const duplicates =
		prompt.occurrenceCount > 1
			? ` · ${prompt.occurrenceCount} occurrences`
			: "";
	return singleLinePrompt(
		`${formatDate(prompt.timestampMs)} · ${session} · ${shortenHome(prompt.cwd)}${duplicates}`,
	);
}

function pickerRow(
	theme: Theme,
	content: string,
	innerWidth: number,
	selected = false,
): string {
	const fitted = truncateToWidth(content, innerWidth, "…");
	const padding = " ".repeat(Math.max(0, innerWidth - visibleWidth(fitted)));
	const body = selected
		? theme.bg("selectedBg", `${fitted}${padding}`)
		: `${fitted}${padding}`;
	return `${theme.fg("border", "│")}${body}${theme.fg("border", "│")}`;
}

class HistoryPicker {
	private readonly input = new Input();
	// Cache the normalized search text per prompt: rebuilding it means three
	// regex passes over every prompt on every keystroke.
	private readonly searchTextCache = new Map<SearchablePrompt, string>();
	private filtered: SearchablePrompt[];
	private selectedIndex = 0;
	private focusedState = false;

	constructor(
		private readonly tui: Tui,
		private readonly theme: Theme,
		private readonly keybindings: Keybindings,
		private readonly prompts: SearchablePrompt[],
		private readonly index: PromptIndex,
		initialQuery: string,
		private readonly done: (action: PickerAction | null) => void,
	) {
		this.input.setValue(initialQuery);
		this.filtered = this.filterPrompts();
	}

	get focused(): boolean {
		return this.focusedState;
	}

	set focused(value: boolean) {
		this.focusedState = value;
		this.input.focused = value;
	}

	handleInput(data: string): void {
		if (
			this.keybindings.matches(data, "tui.select.cancel") ||
			matchesKey(data, Key.ctrl("g"))
		) {
			this.done(null);
			return;
		}
		if (
			this.keybindings.matches(data, "tui.select.down") ||
			matchesKey(data, Key.ctrl("r"))
		) {
			this.moveSelection(1);
			return;
		}
		if (this.keybindings.matches(data, "tui.select.up")) {
			this.moveSelection(-1);
			return;
		}
		if (this.keybindings.matches(data, "tui.select.pageDown")) {
			this.moveSelection(MAX_VISIBLE_RESULTS);
			return;
		}
		if (this.keybindings.matches(data, "tui.select.pageUp")) {
			this.moveSelection(-MAX_VISIBLE_RESULTS);
			return;
		}
		if (matchesKey(data, Key.ctrl("d"))) {
			const prompt = this.filtered[this.selectedIndex];
			if (prompt) {
				this.done({
					kind: "ignore",
					prompt,
					query: this.input.getValue(),
				});
			}
			return;
		}
		if (this.keybindings.matches(data, "tui.select.confirm")) {
			const prompt = this.filtered[this.selectedIndex];
			if (prompt) this.done({ kind: "restore", prompt });
			return;
		}

		const before = this.input.getValue();
		this.input.handleInput(data);
		if (this.input.getValue() !== before) {
			this.filtered = this.filterPrompts();
			this.selectedIndex = 0;
		}
		this.tui.requestRender();
	}

	render(width: number): string[] {
		const innerWidth = Math.max(1, width - 2);
		const border = this.theme.fg("border", "─".repeat(innerWidth));
		const lines = [
			`${this.theme.fg("border", "╭")}${border}${this.theme.fg("border", "╮")}`,
			pickerRow(
				this.theme,
				` ${this.theme.fg("accent", this.theme.bold("Global prompt history"))} ${this.theme.fg("dim", `(${this.filtered.length}/${this.prompts.length})`)}`,
				innerWidth,
			),
			pickerRow(
				this.theme,
				` ${this.theme.fg("accent", "›")} ${this.input.render(Math.max(1, innerWidth - 3))[0] ?? ""}`,
				innerWidth,
			),
			pickerRow(
				this.theme,
				this.theme.fg("dim", ` ${"─".repeat(Math.max(0, innerWidth - 2))} `),
				innerWidth,
			),
		];

		if (this.filtered.length === 0) {
			lines.push(
				pickerRow(
					this.theme,
					` ${this.theme.fg("warning", "No matching prompts")}`,
					innerWidth,
				),
			);
		} else {
			const start = Math.max(
				0,
				Math.min(
					this.selectedIndex - Math.floor(MAX_VISIBLE_RESULTS / 2),
					this.filtered.length - MAX_VISIBLE_RESULTS,
				),
			);
			for (
				let index = start;
				index < Math.min(start + MAX_VISIBLE_RESULTS, this.filtered.length);
				index += 1
			) {
				const prompt = this.filtered[index];
				if (!prompt) continue;
				const selected = index === this.selectedIndex;
				const marker = selected ? this.theme.fg("accent", "›") : " ";
				lines.push(
					pickerRow(
						this.theme,
						` ${marker} ${singleLinePrompt(prompt.text)}`,
						innerWidth,
						selected,
					),
					pickerRow(
						this.theme,
						`   ${this.theme.fg("dim", resultMetadata(prompt))}`,
						innerWidth,
						selected,
					),
				);
			}
		}

		const warnings =
			this.index.malformedSessions + this.index.skippedOversizedPrompts;
		if (warnings > 0) {
			lines.push(
				pickerRow(
					this.theme,
					` ${this.theme.fg("warning", `${warnings} skipped or partially read item(s)`)}`,
					innerWidth,
				),
			);
		}
		const excluded =
			this.index.ignoredSessionCount + this.index.excludedCwdCount;
		lines.push(
			pickerRow(
				this.theme,
				this.theme.fg(
					"dim",
					` ${this.index.scannedSessionCount} sessions · ${formatBytes(this.index.promptBytes)} · ${excluded} excluded · ${this.index.droppedPrompts} beyond limits`,
				),
				innerWidth,
			),
		);
		lines.push(
			pickerRow(
				this.theme,
				this.theme.fg(
					"dim",
					" ↑↓ navigate · ctrl+r older · enter restore · ctrl+d ignore session · esc cancel",
				),
				innerWidth,
			),
			`${this.theme.fg("border", "╰")}${border}${this.theme.fg("border", "╯")}`,
		);
		return lines;
	}

	invalidate(): void {
		this.input.invalidate();
	}

	private readonly promptSearchText = (prompt: SearchablePrompt): string => {
		let text = this.searchTextCache.get(prompt);
		if (text === undefined) {
			text = searchablePromptText(prompt);
			this.searchTextCache.set(prompt, text);
		}
		return text;
	};

	private filterPrompts(): SearchablePrompt[] {
		const query = this.input.getValue().trim();
		return query
			? fuzzyFilter(this.prompts, query, this.promptSearchText)
			: this.prompts;
	}

	private moveSelection(delta: number): void {
		if (this.filtered.length === 0) return;
		this.selectedIndex =
			(this.selectedIndex + delta + this.filtered.length) %
			this.filtered.length;
		this.tui.requestRender();
	}
}

function ignoredMarker(
	prompt: SearchablePrompt,
): Omit<IgnoredSession, "ignoredAt"> {
	return {
		sessionId: prompt.sessionId,
		sessionPath: prompt.sessionPath,
		cwd: prompt.cwd,
		sessionName: prompt.sessionName,
	};
}

function draftQuery(draft: string): string {
	const normalized = singleLinePrompt(draft);
	return normalized.length <= 500 ? normalized : "";
}

type HistoryPickerCycle = {
	readonly ctx: HistoryContext;
	readonly indexer: ReturnType<typeof createPromptIndexer>;
	readonly stateDir: string;
	readonly query: string;
};

async function loadPromptIndex(
	ctx: HistoryContext,
	indexer: ReturnType<typeof createPromptIndexer>,
): Promise<PromptIndex | undefined> {
	ctx.ui.setStatus("global-prompt-history", "Indexing prompt history…");
	try {
		return await indexer.build(ctx);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		ctx.ui.notify(`Could not load prompt history: ${message}`, "error");
		return undefined;
	} finally {
		ctx.ui.setStatus("global-prompt-history", undefined);
	}
}

async function showPromptHistoryPicker(
	options: HistoryPickerCycle,
): Promise<void> {
	const { ctx, indexer, stateDir, query } = options;
	const index = await loadPromptIndex(ctx, indexer);
	if (!index) return;
	if (index.prompts.length === 0) {
		const failures = index.malformedSessions + index.skippedOversizedPrompts;
		const suffix =
			failures > 0 ? ` (${failures} skipped or unreadable item(s))` : "";
		ctx.ui.notify(
			`No saved prompts matched the current exclusions${suffix}`,
			failures > 0 ? "warning" : "info",
		);
		return;
	}

	const action = await ctx.ui.custom<PickerAction | null>(
		(tui, theme, keybindings, done) =>
			new HistoryPicker(
				tui,
				theme,
				keybindings,
				index.prompts,
				index,
				query,
				done,
			),
		{
			overlay: true,
			overlayOptions: {
				anchor: "center",
				width: "80%",
				minWidth: 60,
				maxHeight: 24,
				margin: 1,
			},
		},
	);
	if (!action) return;
	if (action.kind === "restore") {
		ctx.ui.setEditorText(action.prompt.text);
		return;
	}

	const label = singleLinePrompt(
		action.prompt.sessionName ?? basename(action.prompt.sessionPath),
	);
	const confirmed = await ctx.ui.confirm(
		"Ignore prompt-history session?",
		`${label}\n${singleLinePrompt(shortenHome(action.prompt.cwd))}`,
	);
	if (confirmed) {
		await ignoreSession(stateDir, ignoredMarker(action.prompt));
		indexer.clearSession(action.prompt.sessionId);
		ctx.ui.notify(`Ignored session: ${label}`, "info");
	}
	return showPromptHistoryPicker({ ...options, query: action.query });
}

async function openPromptHistory(
	ctx: HistoryContext,
	indexer: ReturnType<typeof createPromptIndexer>,
	explicitQuery = "",
): Promise<void> {
	if (ctx.mode !== "tui") {
		if (ctx.hasUI) {
			ctx.ui.notify(
				"Global prompt history is available only in TUI mode",
				"warning",
			);
		}
		return;
	}

	return showPromptHistoryPicker({
		ctx,
		indexer,
		stateDir: historyPaths(getAgentDir()).stateDir,
		query: explicitQuery.trim() || draftQuery(ctx.ui.getEditorText()),
	});
}

async function ignoreCurrentSession(
	ctx: HistoryContext,
	indexer: ReturnType<typeof createPromptIndexer>,
): Promise<void> {
	const sessionPath = ctx.sessionManager.getSessionFile();
	if (!sessionPath) {
		ctx.ui.notify("The current session is not persisted", "warning");
		return;
	}
	const marker: Omit<IgnoredSession, "ignoredAt"> = {
		sessionId: ctx.sessionManager.getSessionId(),
		sessionPath,
		cwd: ctx.cwd,
		sessionName: ctx.sessionManager.getSessionName(),
	};
	await ignoreSession(historyPaths(getAgentDir()).stateDir, marker);
	indexer.clearSession(marker.sessionId);
	ctx.ui.notify(
		"Current session is now ignored by global prompt history",
		"info",
	);
}

async function includeCurrentSession(ctx: HistoryContext): Promise<void> {
	await includeSession(
		historyPaths(getAgentDir()).stateDir,
		ctx.sessionManager.getSessionId(),
	);
	ctx.ui.notify("Current session is included in global prompt history", "info");
}

async function manageIgnoredSessions(ctx: HistoryContext): Promise<void> {
	if (!ctx.hasUI) return;
	const stateDir = historyPaths(getAgentDir()).stateDir;
	const ignored = await listIgnoredSessions(stateDir);
	if (ignored.length === 0) {
		ctx.ui.notify("No prompt-history sessions are ignored", "info");
		return;
	}
	const labels = ignored.map((session) => {
		const name = session.sessionName ?? basename(session.sessionPath);
		return singleLinePrompt(
			`${name} · ${shortenHome(session.cwd)} · ${session.sessionId.slice(0, 8)}`,
		);
	});
	const selected = await ctx.ui.select("Include an ignored session:", labels);
	if (!selected) return;
	const index = labels.indexOf(selected);
	const session = ignored[index];
	if (!session) return;
	await includeSession(stateDir, session.sessionId);
	ctx.ui.notify("Session restored to global prompt history", "info");
}

export default function globalPromptHistoryExtension(pi: HistoryApi): void {
	const indexer = createPromptIndexer();

	pi.registerShortcut("ctrl+r", {
		description: "Search prompts across all saved Pi sessions",
		handler: async (ctx) => openPromptHistory(ctx, indexer),
	});

	pi.registerCommand("prompt-history", {
		description: "Search prompts across all saved Pi sessions",
		handler: async (args, ctx) => openPromptHistory(ctx, indexer, args),
	});

	pi.registerCommand("prompt-history-ignore-current", {
		description: "Exclude the current session from global prompt history",
		handler: async (_args, ctx) => ignoreCurrentSession(ctx, indexer),
	});

	pi.registerCommand("prompt-history-include-current", {
		description: "Include the current session in global prompt history",
		handler: async (_args, ctx) => includeCurrentSession(ctx),
	});

	pi.registerCommand("prompt-history-ignored", {
		description: "Review and include ignored prompt-history sessions",
		handler: async (_args, ctx) => manageIgnoredSessions(ctx),
	});
}
