/// <reference path="./runtime.d.ts" />

import { createHash } from "node:crypto";
import {
	chmod,
	mkdir,
	readFile,
	readdir,
	rename,
	rm,
	writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export type HistoryConfig = {
	readonly maxPrompts: number;
	readonly maxBytes: number;
	readonly maxPromptBytes: number;
	readonly excludedCwdPrefixes: string[];
};

export type IgnoredSession = {
	readonly sessionId: string;
	readonly sessionPath: string;
	readonly cwd: string;
	readonly sessionName?: string;
	readonly ignoredAt: string;
};

export const DEFAULT_HISTORY_CONFIG: HistoryConfig = {
	maxPrompts: 5_000,
	maxBytes: 16 * 1024 * 1024,
	maxPromptBytes: 256 * 1024,
	excludedCwdPrefixes: [],
};

const MIN_PROMPTS = 100;
const MAX_PROMPTS = 10_000;
const MIN_HISTORY_BYTES = 1024 * 1024;
const MAX_HISTORY_BYTES = 32 * 1024 * 1024;
const MIN_PROMPT_BYTES = 1024;
const MAX_PROMPT_BYTES = 4 * 1024 * 1024;

function boundedInteger(
	value: unknown,
	fallback: number,
	minimum: number,
	maximum: number,
): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	return Math.max(minimum, Math.min(maximum, Math.floor(value)));
}

function expandHome(path: string, home: string): string {
	if (path === "~") return home;
	if (path.startsWith("~/")) return join(home, path.slice(2));
	return path;
}

function excludedCwdPrefixes(value: unknown, home: string): string[] {
	if (value === undefined) return [];
	if (!Array.isArray(value)) {
		throw new Error(
			"excludedCwdPrefixes must be an array of non-empty strings",
		);
	}
	return value.map((candidate) => {
		if (typeof candidate !== "string" || !candidate.trim()) {
			throw new Error(
				"excludedCwdPrefixes must contain only non-empty strings",
			);
		}
		return resolve(expandHome(candidate.trim(), home));
	});
}

function errorCode(error: unknown): string | undefined {
	if (error === null || typeof error !== "object" || !("code" in error)) {
		return undefined;
	}
	const code = (error as { code?: unknown }).code;
	return typeof code === "string" ? code : undefined;
}

export async function loadHistoryConfig(
	configPath: string,
	home: string = homedir(),
): Promise<HistoryConfig> {
	let content: string;
	try {
		content = await readFile(configPath, "utf8");
	} catch (error) {
		if (errorCode(error) === "ENOENT") return DEFAULT_HISTORY_CONFIG;
		throw new Error(`Could not read prompt-history config: ${configPath}`);
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(content);
	} catch {
		throw new Error(`Invalid JSON in prompt-history config: ${configPath}`);
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error(
			`Prompt-history config must be a JSON object: ${configPath}`,
		);
	}
	const input = parsed as Record<string, unknown>;
	const cwdPrefixes = excludedCwdPrefixes(input.excludedCwdPrefixes, home);

	return {
		maxPrompts: boundedInteger(
			input.maxPrompts,
			DEFAULT_HISTORY_CONFIG.maxPrompts,
			MIN_PROMPTS,
			MAX_PROMPTS,
		),
		maxBytes: boundedInteger(
			input.maxBytes,
			DEFAULT_HISTORY_CONFIG.maxBytes,
			MIN_HISTORY_BYTES,
			MAX_HISTORY_BYTES,
		),
		maxPromptBytes: boundedInteger(
			input.maxPromptBytes,
			DEFAULT_HISTORY_CONFIG.maxPromptBytes,
			MIN_PROMPT_BYTES,
			MAX_PROMPT_BYTES,
		),
		excludedCwdPrefixes: cwdPrefixes,
	};
}

export function historyPaths(agentDir: string): {
	readonly configPath: string;
	readonly stateDir: string;
} {
	return {
		configPath: join(agentDir, "global-prompt-history.json"),
		stateDir: join(agentDir, "global-prompt-history"),
	};
}

function ignoredSessionsDirectory(stateDir: string): string {
	return join(stateDir, "ignored-sessions");
}

function ignoredSessionFile(stateDir: string, sessionId: string): string {
	const digest = createHash("sha256").update(sessionId).digest("hex");
	return join(ignoredSessionsDirectory(stateDir), `${digest}.json`);
}

async function ensurePrivateDirectory(path: string): Promise<void> {
	await mkdir(path, { recursive: true, mode: 0o700 });
	await chmod(path, 0o700);
}

function isIgnoredSession(value: unknown): value is IgnoredSession {
	if (!value || typeof value !== "object") return false;
	const candidate = value as Partial<IgnoredSession>;
	return (
		typeof candidate.sessionId === "string" &&
		Boolean(candidate.sessionId) &&
		typeof candidate.sessionPath === "string" &&
		typeof candidate.cwd === "string" &&
		typeof candidate.ignoredAt === "string" &&
		(candidate.sessionName === undefined ||
			typeof candidate.sessionName === "string")
	);
}

export async function listIgnoredSessions(
	stateDir: string,
): Promise<IgnoredSession[]> {
	const directory = ignoredSessionsDirectory(stateDir);
	let names: string[];
	try {
		names = await readdir(directory);
	} catch (error) {
		if (errorCode(error) === "ENOENT") return [];
		throw new Error(
			`Could not read ignored prompt-history sessions: ${directory}`,
		);
	}

	const sessions = await Promise.all(
		names
			.filter((name) => name.endsWith(".json"))
			.map(async (name) => {
				const markerPath = join(directory, name);
				let parsed: unknown;
				try {
					parsed = JSON.parse(await readFile(markerPath, "utf8"));
				} catch {
					throw new Error(`Invalid ignored-session marker: ${markerPath}`);
				}
				if (!isIgnoredSession(parsed)) {
					throw new Error(`Invalid ignored-session marker: ${markerPath}`);
				}
				return parsed;
			}),
	);

	return sessions.sort((left, right) =>
		right.ignoredAt.localeCompare(left.ignoredAt),
	);
}

export async function ignoreSession(
	stateDir: string,
	session: Omit<IgnoredSession, "ignoredAt">,
): Promise<void> {
	const directory = ignoredSessionsDirectory(stateDir);
	await ensurePrivateDirectory(directory);
	const target = ignoredSessionFile(stateDir, session.sessionId);
	const temporary = join(
		dirname(target),
		`.${createHash("sha256")
			.update(`${session.sessionId}:${Date.now()}:${Math.random()}`)
			.digest("hex")}.tmp`,
	);
	const marker: IgnoredSession = {
		...session,
		ignoredAt: new Date().toISOString(),
	};

	await writeFile(temporary, `${JSON.stringify(marker, null, 2)}\n`, {
		encoding: "utf8",
		mode: 0o600,
		flag: "wx",
	});
	await rename(temporary, target);
	await chmod(target, 0o600);
}

export async function includeSession(
	stateDir: string,
	sessionId: string,
): Promise<void> {
	await rm(ignoredSessionFile(stateDir, sessionId), { force: true });
}
