import assert from "node:assert/strict";
import test from "node:test";
import { extractFencedCodeBlocks } from "./parser.ts";

test("preserves logical command lines and continuations", () => {
	const markdown = [
		"Run this:",
		"```bash",
		"nix flake check --all-systems \\",
		"  --override-input nixos-secrets path:./ci-dummy-input \\",
		"  --override-input nixos-work path:./ci-dummy-input",
		"```",
	].join("\n");

	assert.deepEqual(extractFencedCodeBlocks(markdown), [
		{
			language: "bash",
			content:
				"nix flake check --all-systems \\\n  --override-input nixos-secrets path:./ci-dummy-input \\\n  --override-input nixos-work path:./ci-dummy-input",
		},
	]);
});

test("extracts backtick and tilde fences", () => {
	const markdown = [
		"````ts title=demo",
		"const value = 1;",
		"````",
		"~~~",
		"plain",
		"~~~~",
	].join("\n");

	assert.deepEqual(extractFencedCodeBlocks(markdown), [
		{ language: "ts", content: "const value = 1;" },
		{ language: undefined, content: "plain" },
	]);
});

test("does not close a fence with a shorter marker", () => {
	const markdown = ["````bash", "echo one", "```", "echo two", "````"].join(
		"\n",
	);

	assert.deepEqual(extractFencedCodeBlocks(markdown), [
		{ language: "bash", content: "echo one\n```\necho two" },
	]);
});

test("retains an unfinished final block", () => {
	assert.deepEqual(extractFencedCodeBlocks("before\n```sh\necho ready"), [
		{ language: "sh", content: "echo ready" },
	]);
});
