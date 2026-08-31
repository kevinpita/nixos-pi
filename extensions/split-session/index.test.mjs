import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import splitSessionExtension from "./index.ts";

const temporaryDirectories = [];
after(() => {
	for (const directory of temporaryDirectories) {
		rmSync(directory, { recursive: true, force: true });
	}
});

function harness({ idle = true, branch = [] } = {}) {
	const commands = new Map();
	const calls = [];
	const notifications = [];
	const statuses = [];
	const messages = [];
	let tabNumber = 0;
	let waited = false;
	const sessionDirectory = mkdtempSync(join(tmpdir(), "split-session-test-"));
	temporaryDirectories.push(sessionDirectory);

	const pi = {
		registerCommand(name, options) {
			commands.set(name, options);
		},
		getSessionName() {
			return "Parent session";
		},
		sendUserMessage(content) {
			messages.push(content);
		},
		async exec(command, args) {
			calls.push({ command, args });
			if (args[0] === "pane" && args[1] === "current") {
				return {
					code: 0,
					stdout: JSON.stringify({
						result: { pane: { pane_id: "w1:p1", workspace_id: "w1" } },
					}),
					stderr: "",
				};
			}
			if (args[0] === "tab" && args[1] === "create") {
				tabNumber += 1;
				return {
					code: 0,
					stdout: JSON.stringify({
						result: {
							tab: { tab_id: `w1:t${tabNumber + 1}` },
							root_pane: {
								pane_id: `w1:p${tabNumber + 1}`,
								workspace_id: "w1",
							},
						},
					}),
					stderr: "",
				};
			}
			if (args[0] === "agent" && args[1] === "start") {
				return {
					code: 0,
					stdout: JSON.stringify({ result: { agent: { name: args[2] } } }),
					stderr: "",
				};
			}
			throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
		},
	};

	const ctx = {
		cwd: "/work/project",
		sessionManager: {
			getSessionFile: () => join(sessionDirectory, "parent.jsonl"),
			getSessionDir: () => sessionDirectory,
			getSessionId: () => "session-123",
			getHeader: () => ({ type: "session", version: 3 }),
			getBranch: () => branch,
		},
		ui: {
			notify(message, type) {
				notifications.push({ message, type });
			},
			setStatus(key, text) {
				statuses.push({ key, text });
			},
		},
		isIdle() {
			return idle;
		},
		async waitForIdle() {
			waited = true;
		},
	};

	splitSessionExtension(pi);
	return {
		calls,
		commands,
		ctx,
		messages,
		notifications,
		statuses,
		wasWaited: () => waited,
	};
}

test("registers /split and opens N minus one forked Pi tabs", async () => {
	const state = harness();
	const command = state.commands.get("split");
	assert.ok(command);

	await command.handler("3", state.ctx);

	assert.equal(state.wasWaited(), false);
	const tabCalls = state.calls.filter(({ args }) => args[0] === "tab");
	const agentCalls = state.calls.filter(({ args }) => args[0] === "agent");
	assert.equal(tabCalls.length, 2);
	assert.equal(agentCalls.length, 2);
	assert.ok(tabCalls.every(({ args }) => args.includes("--no-focus")));

	const childSessions = [];
	for (const { args } of agentCalls) {
		const separator = args.indexOf("--");
		const piArgs = args.slice(separator + 1);
		assert.equal(piArgs[0], "--session");
		assert.equal(piArgs.includes("--fork"), false);
		childSessions.push(piArgs[1]);
	}
	assert.notEqual(childSessions[0], childSessions[1]);
	assert.notEqual(agentCalls[0].args[2], agentCalls[1].args[2]);
	assert.deepEqual(state.messages, []);
	assert.match(state.notifications.at(-1).message, /Created 2 forked Pi tabs/);
	assert.deepEqual(state.statuses.at(-1), {
		key: "split-session",
		text: undefined,
	});
});

test("splits an active run immediately from before its current prompt", async () => {
	const branch = [
		{
			type: "message",
			id: "user-1",
			parentId: null,
			message: { role: "user", content: "settled prompt" },
		},
		{
			type: "message",
			id: "assistant-1",
			parentId: "user-1",
			message: { role: "assistant", content: "settled response" },
		},
		{
			type: "message",
			id: "user-2",
			parentId: "assistant-1",
			message: { role: "user", content: "active prompt" },
		},
		{
			type: "message",
			id: "assistant-2",
			parentId: "user-2",
			message: { role: "assistant", content: "active tool call" },
		},
	];
	const state = harness({ idle: false, branch });

	await state.commands.get("split").handler("2", state.ctx);

	assert.equal(state.wasWaited(), false);
	const agentCall = state.calls.find(({ args }) => args[0] === "agent");
	const separator = agentCall.args.indexOf("--");
	const piArgs = agentCall.args.slice(separator + 1);
	const sessionArgument = piArgs.indexOf("--session");
	assert.notEqual(sessionArgument, -1);
	const entries = readFileSync(piArgs[sessionArgument + 1], "utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line));
	assert.deepEqual(
		entries
			.filter(({ type }) => type === "message")
			.map(({ message }) => message.content),
		["settled prompt", "settled response"],
	);
});

test("runs an indexed prompt in the current and forked sessions", async () => {
	const state = harness();

	await state.commands.get("split").handler("3 explain me point $i", state.ctx);

	const agentCalls = state.calls.filter(({ args }) => args[0] === "agent");
	const prompts = agentCalls.map(({ args }) => args.at(-1));
	assert.deepEqual(prompts, ["explain me point 2", "explain me point 3"]);
	assert.deepEqual(state.messages, ["explain me point 1"]);
});

test("rejects invalid counts before calling Herdr", async () => {
	const state = harness();
	await state.commands.get("split").handler("1", state.ctx);
	assert.equal(state.calls.length, 0);
	assert.equal(state.notifications.at(-1).type, "error");
});
