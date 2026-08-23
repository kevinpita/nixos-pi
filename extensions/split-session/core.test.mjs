import assert from "node:assert/strict";
import test from "node:test";
import {
	buildAgentName,
	buildPiForkArgs,
	buildSplitLabel,
	expandSplitPrompt,
	MAX_SPLIT_SESSIONS,
	parseSplitArgs,
	parseSplitCount,
} from "./core.ts";

test("parses the requested total session count", () => {
	assert.equal(parseSplitCount("5"), 5);
	assert.equal(parseSplitCount(" 12 "), MAX_SPLIT_SESSIONS);
});

test("rejects malformed and out-of-range split counts", () => {
	for (const value of ["", "1", "13", "2 extra", "2.5", "-2"]) {
		assert.throws(() => parseSplitCount(value));
	}
});

test("parses an optional prompt after the split count", () => {
	assert.deepEqual(parseSplitArgs("3"), { count: 3 });
	assert.deepEqual(parseSplitArgs(" 3   explain me point $i "), {
		count: 3,
		prompt: "explain me point $i",
	});
});

test("expands every split index placeholder", () => {
	assert.equal(expandSplitPrompt("point $i of $i", 4), "point 4 of 4");
	assert.equal(expandSplitPrompt("same prompt", 4), "same prompt");
});

test("builds bounded tab labels from the parent session name", () => {
	assert.equal(buildSplitLabel("Fix MPT ledger", 2, 5), "Fix MPT ledger 2/5");
	assert.equal(buildSplitLabel(undefined, 3, 5), "split 3/5");
	assert.equal(
		buildSplitLabel("line one\nline two", 4, 5),
		"line one line two 4/5",
	);
	assert.ok(buildSplitLabel("x".repeat(100), 5, 5).length <= 64);
});

test("builds unique Herdr-compatible agent names", () => {
	const first = buildAgentName("019fc7e1-0c8d", "run-a", 2);
	const nextIndex = buildAgentName("019fc7e1-0c8d", "run-a", 3);
	const nextRun = buildAgentName("019fc7e1-0c8d", "run-b", 2);
	assert.match(first, /^[a-z][a-z0-9_-]{0,31}$/);
	assert.match(nextIndex, /^[a-z][a-z0-9_-]{0,31}$/);
	assert.match(nextRun, /^[a-z][a-z0-9_-]{0,31}$/);
	assert.notEqual(first, nextIndex);
	assert.notEqual(first, nextRun);
});

test("builds Pi arguments that fork instead of sharing a session file", () => {
	assert.deepEqual(buildPiForkArgs("/tmp/parent.jsonl", "split 2/5"), [
		"--fork",
		"/tmp/parent.jsonl",
		"--name",
		"split 2/5",
	]);
	assert.deepEqual(
		buildPiForkArgs("/tmp/parent.jsonl", "split 2/5", "explain point 2"),
		["--fork", "/tmp/parent.jsonl", "--name", "split 2/5", "explain point 2"],
	);
});
