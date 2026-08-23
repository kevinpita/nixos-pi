/// <reference path="./runtime.d.ts" />

import { open, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import {
	promptRecordFromEntry,
	type ParsedHistorySession,
	type PromptRecord,
	type SessionDescriptor,
} from "./history.ts";

const HEADER_BYTES = 64 * 1024;
const READ_CHUNK_BYTES = 64 * 1024;
const MIN_LINE_CHARACTERS = 1024 * 1024;
const MAX_LINE_CHARACTERS = 8 * 1024 * 1024;

export type SessionFileMetadata = {
	readonly descriptor: SessionDescriptor;
	readonly fingerprint: string;
};

export type SessionParseOptions = {
	readonly maxPromptBytes: number;
	readonly maxPrompts: number;
	readonly maxBytes: number;
};

type SessionHeader = {
	readonly type?: unknown;
	readonly id?: unknown;
	readonly cwd?: unknown;
};

type SessionInfoEntry = {
	readonly type?: unknown;
	readonly name?: unknown;
};

function isSessionHeader(value: unknown): value is SessionHeader {
	if (!value || typeof value !== "object") return false;
	const candidate = value as SessionHeader;
	return (
		candidate.type === "session" &&
		typeof candidate.id === "string" &&
		Boolean(candidate.id) &&
		typeof candidate.cwd === "string"
	);
}

async function readFirstLine(path: string): Promise<string | undefined> {
	const handle = await open(path, "r");
	try {
		const buffer = new Uint8Array(HEADER_BYTES);
		const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
		if (bytesRead === 0) return undefined;
		const text = new TextDecoder().decode(buffer.subarray(0, bytesRead));
		const newline = text.indexOf("\n");
		if (newline < 0 && bytesRead === HEADER_BYTES) return undefined;
		return (newline < 0 ? text : text.slice(0, newline)).trim();
	} finally {
		await handle.close();
	}
}

export async function readSessionFileMetadata(
	path: string,
): Promise<SessionFileMetadata | undefined> {
	const [line, file] = await Promise.all([readFirstLine(path), stat(path)]);
	if (!line) return undefined;
	let header: unknown;
	try {
		header = JSON.parse(line);
	} catch {
		return undefined;
	}
	if (!isSessionHeader(header)) return undefined;
	return {
		descriptor: {
			id: header.id as string,
			path,
			cwd: header.cwd as string,
			modifiedMs: file.mtimeMs,
		},
		fingerprint: `${file.mtimeMs}:${file.size}`,
	};
}

export async function discoverSessionFiles(root: string): Promise<string[]> {
	let entries;
	try {
		entries = await readdir(root, { withFileTypes: true });
	} catch (error) {
		if (isMissingPath(error)) return [];
		throw error;
	}

	const files = entries.flatMap((entry) => {
		if (!entry.isFile() || !entry.name.endsWith(".jsonl")) return [];
		return [join(root, entry.name)];
	});
	const nested = await Promise.all(
		entries.flatMap((entry) => {
			if (!entry.isDirectory() || entry.isSymbolicLink()) return [];
			return [discoverSessionFiles(join(root, entry.name))];
		}),
	);
	return files.concat(...nested);
}

function isMissingPath(error: unknown): boolean {
	return (
		error !== null &&
		typeof error === "object" &&
		"code" in error &&
		(error as { code?: unknown }).code === "ENOENT"
	);
}

class SessionPromptAccumulator {
	private readonly session: SessionDescriptor;
	private readonly options: SessionParseOptions;
	private prompts: PromptRecord[] = [];
	private promptBytes = 0;
	private malformedLines = 0;
	private skippedOversizedPrompts = 0;
	private droppedPrompts = 0;
	private sessionName: string | undefined;
	private lineNumber = 0;

	constructor(session: SessionDescriptor, options: SessionParseOptions) {
		this.session = session;
		this.options = options;
	}

	addMalformedLine(): void {
		this.malformedLines += 1;
	}

	addLine(line: string): void {
		this.lineNumber += 1;
		if (!line.trim()) return;
		let entry: unknown;
		try {
			entry = JSON.parse(line);
		} catch {
			this.addMalformedLine();
			return;
		}

		const info = entry as SessionInfoEntry;
		if (info.type === "session_info" && typeof info.name === "string") {
			this.sessionName = info.name.trim() || undefined;
			return;
		}

		const result = promptRecordFromEntry(
			entry,
			this.session,
			`${this.session.id}:line-${this.lineNumber}`,
			this.options.maxPromptBytes,
		);
		if (result.oversized) {
			this.skippedOversizedPrompts += 1;
			return;
		}
		if (!result.prompt) return;
		this.prompts.push(result.prompt);
		this.promptBytes += result.prompt.textBytes;
		this.enforceBounds();
	}

	finish(): ParsedHistorySession {
		const prompts = this.sessionName
			? this.prompts.map((prompt) => ({
					...prompt,
					sessionName: this.sessionName,
				}))
			: this.prompts;
		return {
			prompts,
			malformedLines: this.malformedLines,
			skippedOversizedPrompts: this.skippedOversizedPrompts,
			droppedPrompts: this.droppedPrompts,
			promptBytes: this.promptBytes,
		};
	}

	private enforceBounds(): void {
		while (
			this.prompts.length > this.options.maxPrompts ||
			this.promptBytes > this.options.maxBytes
		) {
			const removed = this.prompts.shift();
			if (!removed) break;
			this.promptBytes -= removed.textBytes;
			this.droppedPrompts += 1;
		}
	}
}

type LineStreamState = {
	remainder: string;
	droppingLongLine: boolean;
};

function consumeDecodedText(
	decoded: string,
	state: LineStreamState,
	maxLineCharacters: number,
	accumulator: SessionPromptAccumulator,
): void {
	let start = 0;
	let newline = decoded.indexOf("\n", start);
	while (newline >= 0) {
		const segment = decoded.slice(start, newline);
		if (state.droppingLongLine) {
			state.droppingLongLine = false;
			accumulator.addMalformedLine();
		} else {
			const line = state.remainder + segment;
			if (line.length > maxLineCharacters) accumulator.addMalformedLine();
			else accumulator.addLine(line);
		}
		state.remainder = "";
		start = newline + 1;
		newline = decoded.indexOf("\n", start);
	}

	if (state.droppingLongLine) return;
	state.remainder += decoded.slice(start);
	if (state.remainder.length > maxLineCharacters) {
		state.remainder = "";
		state.droppingLongLine = true;
	}
}

async function streamSessionLines(
	path: string,
	maxLineCharacters: number,
	accumulator: SessionPromptAccumulator,
): Promise<void> {
	const handle = await open(path, "r");
	const decoder = new TextDecoder();
	const buffer = new Uint8Array(READ_CHUNK_BYTES);
	const state: LineStreamState = { remainder: "", droppingLongLine: false };

	try {
		while (true) {
			const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
			if (bytesRead === 0) break;
			consumeDecodedText(
				decoder.decode(buffer.subarray(0, bytesRead), { stream: true }),
				state,
				maxLineCharacters,
				accumulator,
			);
		}
		consumeDecodedText(decoder.decode(), state, maxLineCharacters, accumulator);
		if (state.droppingLongLine) accumulator.addMalformedLine();
		else if (state.remainder) accumulator.addLine(state.remainder);
	} finally {
		await handle.close();
	}
}

export async function parseHistorySessionFile(
	metadata: SessionFileMetadata,
	options: SessionParseOptions,
): Promise<ParsedHistorySession> {
	const accumulator = new SessionPromptAccumulator(
		metadata.descriptor,
		options,
	);
	const maxLineCharacters = Math.min(
		MAX_LINE_CHARACTERS,
		Math.max(MIN_LINE_CHARACTERS, options.maxPromptBytes * 6),
	);
	await streamSessionLines(
		metadata.descriptor.path,
		maxLineCharacters,
		accumulator,
	);
	return accumulator.finish();
}
