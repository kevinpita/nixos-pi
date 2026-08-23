import assert from "node:assert/strict";
import test from "node:test";
import splitSessionExtension from "./index.ts";

function harness() {
	const commands = new Map();
	const calls = [];
	const notifications = [];
	const statuses = [];
	const messages = [];
	let tabNumber = 0;
	let waited = false;

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
			getSessionFile: () => "/sessions/parent.jsonl",
			getSessionId: () => "session-123",
		},
		ui: {
			notify(message, type) {
				notifications.push({ message, type });
			},
			setStatus(key, text) {
				statuses.push({ key, text });
			},
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

	assert.equal(state.wasWaited(), true);
	const tabCalls = state.calls.filter(({ args }) => args[0] === "tab");
	const agentCalls = state.calls.filter(({ args }) => args[0] === "agent");
	assert.equal(tabCalls.length, 2);
	assert.equal(agentCalls.length, 2);
	assert.ok(tabCalls.every(({ args }) => args.includes("--no-focus")));

	for (const { args } of agentCalls) {
		const separator = args.indexOf("--");
		const piArgs = args.slice(separator + 1);
		assert.deepEqual(piArgs.slice(0, 2), ["--fork", "/sessions/parent.jsonl"]);
		assert.equal(piArgs.includes("--session"), false);
	}
	assert.notEqual(agentCalls[0].args[2], agentCalls[1].args[2]);
	assert.deepEqual(state.messages, []);
	assert.match(state.notifications.at(-1).message, /Created 2 forked Pi tabs/);
	assert.deepEqual(state.statuses.at(-1), {
		key: "split-session",
		text: undefined,
	});
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
