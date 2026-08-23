import assert from "node:assert/strict";
import test from "node:test";
import {
	applyHistoryBounds,
	buildBoundedHistory,
	collapseExactPrompts,
	isCwdExcluded,
	parseHistorySessionContent,
	promptsFromSessionEntries,
	singleLinePrompt,
	textFromUserContent,
	trimPromptRecords,
	utf8Bytes,
} from "./history.ts";

const session = {
	id: "session-a",
	path: "/sessions/a.jsonl",
	cwd: "/work/project-a",
	name: "Project A",
	modifiedMs: 1_700_000_000_000,
};

function record(overrides = {}) {
	const text = overrides.text ?? "prompt";
	return {
		text,
		textBytes: utf8Bytes(text),
		timestampMs: 100,
		entryId: "entry-a",
		sessionId: "session-a",
		sessionPath: "/sessions/a.jsonl",
		sessionName: "Session A",
		cwd: "/work/project-a",
		...overrides,
	};
}

test("extracts every textual content block without images", () => {
	assert.equal(
		textFromUserContent([
			{ type: "text", text: "first" },
			{ type: "image", data: "ignored" },
			{ type: "text", text: "second" },
		]),
		"first\nsecond",
	);
	assert.equal(
		textFromUserContent([{ type: "image", data: "only" }]),
		undefined,
	);
});

test("parses user prompts while tolerating malformed and oversized lines", () => {
	const content = [
		JSON.stringify({ type: "session", id: "header" }),
		JSON.stringify({
			type: "message",
			id: "user-1",
			timestamp: "2026-07-20T10:00:00.000Z",
			message: { role: "user", content: " keep me " },
		}),
		"{unfinished",
		JSON.stringify({
			type: "message",
			id: "assistant-1",
			message: { role: "assistant", content: "not indexed" },
		}),
		JSON.stringify({
			type: "message",
			id: "user-2",
			message: { role: "user", content: "this prompt is too large" },
		}),
	].join("\n");

	const parsed = parseHistorySessionContent(content, session, 10);
	assert.equal(parsed.malformedLines, 1);
	assert.equal(parsed.skippedOversizedPrompts, 1);
	assert.equal(parsed.prompts.length, 1);
	assert.equal(parsed.prompts[0].text, "keep me");
	assert.equal(parsed.prompts[0].entryId, "user-1");
	assert.equal(parsed.prompts[0].sessionName, "Project A");
});

test("deduplicates exact prompts while keeping newest provenance", () => {
	const collapsed = collapseExactPrompts([
		record({ timestampMs: 100, entryId: "old", sessionId: "session-a" }),
		record({
			timestampMs: 300,
			entryId: "new",
			sessionId: "session-b",
			sessionPath: "/sessions/b.jsonl",
		}),
		record({
			text: "different",
			textBytes: utf8Bytes("different"),
			timestampMs: 200,
			entryId: "different",
		}),
	]);

	assert.equal(collapsed.length, 2);
	assert.equal(collapsed[0].entryId, "new");
	assert.equal(collapsed[0].occurrenceCount, 2);
	assert.equal(collapsed[0].sourceSessionCount, 2);
});

test("enforces prompt-count and UTF-8 byte limits", () => {
	const searchable = collapseExactPrompts([
		record({ text: "one", textBytes: 3, timestampMs: 300 }),
		record({ text: "two", textBytes: 3, timestampMs: 200, entryId: "two" }),
		record({ text: "three", textBytes: 5, timestampMs: 100, entryId: "three" }),
	]);
	assert.deepEqual(
		applyHistoryBounds(searchable, { maxPrompts: 2, maxBytes: 6 }),
		{
			prompts: searchable.slice(0, 2),
			promptBytes: 6,
			droppedPrompts: 1,
		},
	);

	const bounded = buildBoundedHistory(
		[
			record({ text: "same", textBytes: 4, timestampMs: 300 }),
			record({ text: "same", textBytes: 4, timestampMs: 200, entryId: "copy" }),
		],
		{ maxPrompts: 1, maxBytes: 4 },
	);
	assert.equal(bounded.prompts.length, 1);
	assert.equal(bounded.prompts[0].occurrenceCount, 2);
	assert.equal(bounded.promptBytes, 4);
});

test("bounds live session entries during extraction", () => {
	const entries = ["old", "middle", "new"].map((text, index) => ({
		type: "message",
		id: `entry-${index}`,
		message: { role: "user", content: text },
	}));
	const parsed = promptsFromSessionEntries(entries, session, 1024, {
		maxPrompts: 2,
		maxBytes: 1024,
	});
	assert.deepEqual(
		parsed.prompts.map(({ text }) => text),
		["middle", "new"],
	);
	assert.equal(parsed.droppedPrompts, 1);
});

test("bounds raw candidates before global deduplication", () => {
	const candidates = trimPromptRecords(
		[
			record({ text: "new", textBytes: 3, timestampMs: 300 }),
			record({ text: "middle", textBytes: 6, timestampMs: 200 }),
			record({ text: "old", textBytes: 3, timestampMs: 100 }),
		],
		{ maxPrompts: 2, maxBytes: 6 },
	);
	assert.deepEqual(
		candidates.records.map(({ text }) => text),
		["new", "old"],
	);
	assert.equal(candidates.promptBytes, 6);
	assert.equal(candidates.droppedPrompts, 1);
});

test("removes terminal control sequences from searchable previews", () => {
	assert.equal(
		singleLinePrompt("safe\u001b[31m red\u001b[0m\nnext\u0000line"),
		"safe red next line",
	);
});

test("matches cwd exclusions only at directory boundaries", () => {
	assert.equal(
		isCwdExcluded("/home/kevin/private/client", ["/home/kevin/private"]),
		true,
	);
	assert.equal(
		isCwdExcluded("/home/kevin/private", ["/home/kevin/private/"]),
		true,
	);
	assert.equal(
		isCwdExcluded("/home/kevin/private-other", ["/home/kevin/private"]),
		false,
	);
});
