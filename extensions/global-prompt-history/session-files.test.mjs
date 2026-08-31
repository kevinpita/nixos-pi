import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	discoverSessionFiles,
	parseHistorySessionFile,
	readSessionFileMetadata,
} from "./session-files.ts";

async function temporaryDirectory() {
	return mkdtemp(join(tmpdir(), "pi-history-session-files-test-"));
}

function message(id, text, timestamp) {
	return JSON.stringify({
		type: "message",
		id,
		timestamp,
		message: { role: "user", content: text },
	});
}

test("discovers only primary session JSONL files", async () => {
	const root = await temporaryDirectory();
	const primaryDirectory = join(root, "work-a");
	const childDirectory = join(primaryDirectory, "parent-session", "run-0");
	await mkdir(childDirectory, { recursive: true });
	const valid = join(primaryDirectory, "valid.jsonl");
	const invalid = join(primaryDirectory, "invalid.jsonl");
	const child = join(childDirectory, "session.jsonl");
	await writeFile(
		valid,
		`${JSON.stringify({ type: "session", id: "session-a", cwd: "/work/a" })}\n`,
		"utf8",
	);
	await writeFile(invalid, "not a session header\n", "utf8");
	await writeFile(
		child,
		`${JSON.stringify({ type: "session", id: "child-a", cwd: "/work/a" })}\n`,
		"utf8",
	);
	await writeFile(join(root, "ignored.txt"), "ignored", "utf8");

	assert.deepEqual(
		new Set(await discoverSessionFiles(root)),
		new Set([valid, invalid]),
	);
	const metadata = await readSessionFileMetadata(valid);
	assert.equal(metadata.descriptor.id, "session-a");
	assert.equal(metadata.descriptor.cwd, "/work/a");
	assert.equal(await readSessionFileMetadata(invalid), undefined);
});

test("streams session lines, bounds prompts, and applies the final session name", async () => {
	const root = await temporaryDirectory();
	const path = join(root, "session.jsonl");
	const hugeAssistant = JSON.stringify({
		type: "message",
		id: "assistant",
		message: { role: "assistant", content: "x".repeat(1024 * 1024 + 100) },
	});
	await writeFile(
		path,
		[
			JSON.stringify({ type: "session", id: "session-a", cwd: "/work/a" }),
			message("old", "old prompt", "2026-07-20T10:00:00.000Z"),
			hugeAssistant,
			message("new", "new prompt", "2026-07-21T10:00:00.000Z"),
			JSON.stringify({ type: "session_info", name: "Final session name" }),
		].join("\n"),
		"utf8",
	);

	const metadata = await readSessionFileMetadata(path);
	const parsed = await parseHistorySessionFile(metadata, {
		maxPromptBytes: 1024,
		maxPrompts: 1,
		maxBytes: 1024,
	});
	assert.equal(parsed.prompts.length, 1);
	assert.equal(parsed.prompts[0].text, "new prompt");
	assert.equal(parsed.prompts[0].sessionName, "Final session name");
	assert.equal(parsed.droppedPrompts, 1);
	assert.equal(parsed.malformedLines, 1);
});
