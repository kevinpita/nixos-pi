import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	DEFAULT_HISTORY_CONFIG,
	ignoreSession,
	includeSession,
	listIgnoredSessions,
	loadHistoryConfig,
} from "./storage.ts";

async function temporaryDirectory() {
	return mkdtemp(join(tmpdir(), "pi-global-history-test-"));
}

test("uses bounded defaults only when configuration is absent", async () => {
	const root = await temporaryDirectory();
	assert.deepEqual(
		await loadHistoryConfig(join(root, "missing.json"), "/test-home"),
		DEFAULT_HISTORY_CONFIG,
	);

	const configPath = join(root, "config.json");
	await writeFile(configPath, "not json", "utf8");
	await assert.rejects(
		loadHistoryConfig(configPath, "/test-home"),
		/Invalid JSON/,
	);
	await writeFile(configPath, "null", "utf8");
	await assert.rejects(
		loadHistoryConfig(configPath, "/test-home"),
		/must be a JSON object/,
	);
});

test("clamps numeric configuration and expands cwd prefixes", async () => {
	const root = await temporaryDirectory();
	const configPath = join(root, "config.json");
	await writeFile(
		configPath,
		JSON.stringify({
			maxPrompts: 2,
			maxBytes: Number.MAX_SAFE_INTEGER,
			maxPromptBytes: 2048,
			excludedCwdPrefixes: ["~/private"],
		}),
		"utf8",
	);

	const config = await loadHistoryConfig(configPath, "/test-home");
	assert.equal(config.maxPrompts, 100);
	assert.equal(config.maxBytes, 32 * 1024 * 1024);
	assert.equal(config.maxPromptBytes, 2048);
	assert.deepEqual(config.excludedCwdPrefixes, ["/test-home/private"]);

	await writeFile(
		configPath,
		JSON.stringify({ excludedCwdPrefixes: "~/private" }),
		"utf8",
	);
	await assert.rejects(
		loadHistoryConfig(configPath, "/test-home"),
		/excludedCwdPrefixes must be an array/,
	);
});

test("stores ignored sessions independently and restores one safely", async () => {
	const root = await temporaryDirectory();
	const stateDir = join(root, "state");
	const sessions = [
		{
			sessionId: "session-a",
			sessionPath: "/sessions/a.jsonl",
			cwd: "/work/a",
			sessionName: "Session A",
		},
		{
			sessionId: "session-b",
			sessionPath: "/sessions/b.jsonl",
			cwd: "/work/b",
		},
	];
	await Promise.all(
		sessions.map((session) => ignoreSession(stateDir, session)),
	);

	const ignored = await listIgnoredSessions(stateDir);
	assert.deepEqual(
		new Set(ignored.map((session) => session.sessionId)),
		new Set(["session-a", "session-b"]),
	);

	await includeSession(stateDir, "session-a");
	assert.deepEqual(
		(await listIgnoredSessions(stateDir)).map((session) => session.sessionId),
		["session-b"],
	);

	if (process.platform !== "win32") {
		const markerDirectory = join(stateDir, "ignored-sessions");
		const directory = await stat(markerDirectory);
		assert.equal(directory.mode & 0o777, 0o700);
		const markerNames = await readdir(markerDirectory);
		const marker = await stat(join(markerDirectory, markerNames[0]));
		assert.equal(marker.mode & 0o777, 0o600);
	}
});

test("fails closed for malformed marker files", async () => {
	const root = await temporaryDirectory();
	const markers = join(root, "state", "ignored-sessions");
	await mkdir(markers, { recursive: true });
	await writeFile(join(markers, "broken.json"), "{broken", "utf8");
	await writeFile(
		join(markers, "wrong.json"),
		JSON.stringify({ sessionId: "missing fields" }),
		"utf8",
	);
	await assert.rejects(
		listIgnoredSessions(join(root, "state")),
		/Invalid ignored-session marker/,
	);
});
