/// <reference path="./runtime.d.ts" />

import { resolve, sep } from "node:path";

export type SessionDescriptor = {
	readonly id: string;
	readonly path: string;
	readonly cwd: string;
	readonly name?: string;
	readonly modifiedMs: number;
};

export type PromptRecord = {
	readonly text: string;
	readonly textBytes: number;
	readonly timestampMs: number;
	readonly entryId: string;
	readonly sessionId: string;
	readonly sessionPath: string;
	readonly sessionName?: string;
	readonly cwd: string;
};

export type SearchablePrompt = PromptRecord & {
	readonly occurrenceCount: number;
	readonly sourceSessionCount: number;
};

export type ParsedHistorySession = {
	readonly prompts: PromptRecord[];
	readonly malformedLines: number;
	readonly skippedOversizedPrompts: number;
	readonly droppedPrompts: number;
	readonly promptBytes: number;
};

export type HistoryBounds = {
	readonly maxPrompts: number;
	readonly maxBytes: number;
};

export type BoundedHistory = {
	readonly prompts: SearchablePrompt[];
	readonly promptBytes: number;
	readonly droppedPrompts: number;
};

export type BoundedPromptRecords = {
	readonly records: PromptRecord[];
	readonly promptBytes: number;
	readonly droppedPrompts: number;
};

type SessionEntryLike = {
	readonly type?: unknown;
	readonly id?: unknown;
	readonly timestamp?: unknown;
	readonly message?: unknown;
};

type UserMessageLike = {
	readonly role?: unknown;
	readonly content?: unknown;
	readonly timestamp?: unknown;
};

export function utf8Bytes(text: string): number {
	return Buffer.byteLength(text, "utf8");
}

export function textFromUserContent(content: unknown): string | undefined {
	if (typeof content === "string") {
		const text = content.trim();
		return text || undefined;
	}
	if (!Array.isArray(content)) return undefined;

	const text = content
		.flatMap((block) => {
			if (!block || typeof block !== "object") return [];
			const candidate = block as { type?: unknown; text?: unknown };
			return candidate.type === "text" && typeof candidate.text === "string"
				? [candidate.text]
				: [];
		})
		.join("\n")
		.trim();
	return text || undefined;
}

function timestampMs(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value !== "string") return undefined;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}

export function promptRecordFromEntry(
	entry: unknown,
	session: SessionDescriptor,
	fallbackEntryId: string,
	maxPromptBytes: number,
): { prompt?: PromptRecord; oversized: boolean } {
	if (!entry || typeof entry !== "object") return { oversized: false };
	const candidate = entry as SessionEntryLike;
	if (
		candidate.type !== "message" ||
		!candidate.message ||
		typeof candidate.message !== "object"
	) {
		return { oversized: false };
	}

	const message = candidate.message as UserMessageLike;
	if (message.role !== "user") return { oversized: false };
	const text = textFromUserContent(message.content);
	if (!text) return { oversized: false };

	const textBytes = utf8Bytes(text);
	if (textBytes > maxPromptBytes) return { oversized: true };

	return {
		oversized: false,
		prompt: {
			text,
			textBytes,
			timestampMs:
				timestampMs(message.timestamp) ??
				timestampMs(candidate.timestamp) ??
				session.modifiedMs,
			entryId:
				typeof candidate.id === "string" && candidate.id.trim()
					? candidate.id
					: fallbackEntryId,
			sessionId: session.id,
			sessionPath: session.path,
			sessionName: session.name,
			cwd: session.cwd,
		},
	};
}

export function promptsFromSessionEntries(
	entries: readonly unknown[],
	session: SessionDescriptor,
	maxPromptBytes: number,
	bounds?: HistoryBounds,
): ParsedHistorySession {
	const prompts: PromptRecord[] = [];
	let skippedOversizedPrompts = 0;
	let droppedPrompts = 0;
	let promptBytes = 0;

	for (let index = 0; index < entries.length; index += 1) {
		const result = promptRecordFromEntry(
			entries[index],
			session,
			`${session.id}:entry-${index}`,
			maxPromptBytes,
		);
		if (result.oversized) {
			skippedOversizedPrompts += 1;
			continue;
		}
		if (!result.prompt) continue;
		prompts.push(result.prompt);
		promptBytes += result.prompt.textBytes;
		while (
			bounds &&
			(prompts.length > bounds.maxPrompts || promptBytes > bounds.maxBytes)
		) {
			const removed = prompts.shift();
			if (!removed) break;
			promptBytes -= removed.textBytes;
			droppedPrompts += 1;
		}
	}

	return {
		prompts,
		malformedLines: 0,
		skippedOversizedPrompts,
		droppedPrompts,
		promptBytes,
	};
}

export function parseHistorySessionContent(
	content: string,
	session: SessionDescriptor,
	maxPromptBytes: number,
): ParsedHistorySession {
	const prompts: PromptRecord[] = [];
	let malformedLines = 0;
	let skippedOversizedPrompts = 0;
	let promptBytes = 0;
	let lineNumber = 0;

	for (const line of content.split("\n")) {
		lineNumber += 1;
		if (!line.trim()) continue;
		try {
			const result = promptRecordFromEntry(
				JSON.parse(line),
				session,
				`${session.id}:line-${lineNumber}`,
				maxPromptBytes,
			);
			if (result.oversized) skippedOversizedPrompts += 1;
			if (result.prompt) {
				prompts.push(result.prompt);
				promptBytes += result.prompt.textBytes;
			}
		} catch {
			malformedLines += 1;
		}
	}

	return {
		prompts,
		malformedLines,
		skippedOversizedPrompts,
		droppedPrompts: 0,
		promptBytes,
	};
}

function boundRecords<T extends { readonly textBytes: number }>(
	records: readonly T[],
	bounds: HistoryBounds,
): { records: T[]; promptBytes: number; droppedPrompts: number } {
	const retained: T[] = [];
	let promptBytes = 0;
	let droppedPrompts = 0;
	for (const record of records) {
		if (
			retained.length >= bounds.maxPrompts ||
			promptBytes + record.textBytes > bounds.maxBytes
		) {
			droppedPrompts += 1;
			continue;
		}
		retained.push(record);
		promptBytes += record.textBytes;
	}
	return { records: retained, promptBytes, droppedPrompts };
}

export function trimPromptRecords(
	records: readonly PromptRecord[],
	bounds: HistoryBounds,
): BoundedPromptRecords {
	const sorted = [...records].sort(
		(left, right) => right.timestampMs - left.timestampMs,
	);
	return boundRecords(sorted, bounds);
}

export function collapseExactPrompts(
	records: readonly PromptRecord[],
): SearchablePrompt[] {
	const sorted = [...records].sort(
		(left, right) => right.timestampMs - left.timestampMs,
	);
	const grouped = new Map<
		string,
		{ primary: PromptRecord; occurrences: number; sessionIds: Set<string> }
	>();

	for (const record of sorted) {
		const existing = grouped.get(record.text);
		if (existing) {
			existing.occurrences += 1;
			existing.sessionIds.add(record.sessionId);
			continue;
		}
		grouped.set(record.text, {
			primary: record,
			occurrences: 1,
			sessionIds: new Set([record.sessionId]),
		});
	}

	return [...grouped.values()].map(({ primary, occurrences, sessionIds }) => ({
		...primary,
		occurrenceCount: occurrences,
		sourceSessionCount: sessionIds.size,
	}));
}

export function applyHistoryBounds(
	records: readonly SearchablePrompt[],
	bounds: HistoryBounds,
): BoundedHistory {
	const { records: prompts, promptBytes, droppedPrompts } = boundRecords(
		records,
		bounds,
	);
	return { prompts, promptBytes, droppedPrompts };
}

export function buildBoundedHistory(
	records: readonly PromptRecord[],
	bounds: HistoryBounds,
): BoundedHistory {
	return applyHistoryBounds(collapseExactPrompts(records), bounds);
}

function normalizeDirectory(path: string): string {
	const normalized = resolve(path);
	return normalized.endsWith(sep) && normalized !== sep
		? normalized.slice(0, -sep.length)
		: normalized;
}

export function isCwdExcluded(
	cwd: string,
	prefixes: readonly string[],
): boolean {
	const normalizedCwd = normalizeDirectory(cwd);
	return prefixes.some((prefix) => {
		const normalizedPrefix = normalizeDirectory(prefix);
		return (
			normalizedCwd === normalizedPrefix ||
			normalizedCwd.startsWith(`${normalizedPrefix}${sep}`)
		);
	});
}

export function singleLinePrompt(text: string): string {
	return text
		.replace(
			/\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\)|[@-_])/g,
			" ",
		)
		.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

export function searchablePromptText(prompt: SearchablePrompt): string {
	return singleLinePrompt(
		`${prompt.text} ${prompt.sessionName ?? ""} ${prompt.cwd}`,
	);
}
