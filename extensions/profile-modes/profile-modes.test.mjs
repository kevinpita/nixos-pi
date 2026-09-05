import assert from "node:assert/strict";
import test from "node:test";
import profileModes from "./index.ts";
import {
	buildProfilePrompt,
	filterReadOnlyTools,
	mergeProfile,
	parseProfileInvocation,
	restoreProfileState,
} from "./core.ts";

const originalModel = { provider: "openai-codex", id: "gpt-5.6-terra" };
const profileModel = { provider: "openai-codex", id: "gpt-6-astra" };
const activeTools = [
	"read",
	"bash",
	"edit",
	"ffgrep",
	"web_search",
	"subagent",
];

function createHarness({ initialEntries = [] } = {}) {
	const commands = new Map();
	const handlers = new Map();
	const sentMessages = [];
	const notifications = [];
	const statuses = [];
	const modelChanges = [];
	const toolChanges = [];
	let thinkingLevel = "high";
	let tools = [...activeTools];
	let model = originalModel;
	let branch = structuredClone(initialEntries);

	const pi = {
		registerCommand(name, definition) {
			commands.set(name, definition);
		},
		on(name, handler) {
			handlers.set(name, handler);
		},
		getThinkingLevel() {
			return thinkingLevel;
		},
		setThinkingLevel(level) {
			thinkingLevel = level;
		},
		getActiveTools() {
			return [...tools];
		},
		setActiveTools(names) {
			tools = [...names];
			toolChanges.push([...names]);
		},
		async setModel(next) {
			model = next;
			modelChanges.push(next);
			return true;
		},
		sendUserMessage(content, options) {
			sentMessages.push({ content, options });
		},
		appendEntry(customType, data) {
			branch.push({ type: "custom", customType, data: structuredClone(data) });
		},
	};

	const ctx = {
		get model() {
			return model;
		},
		modelRegistry: {
			find(provider, id) {
				if (provider === profileModel.provider && id === profileModel.id)
					return profileModel;
				if (provider === originalModel.provider && id === originalModel.id)
					return originalModel;
				return undefined;
			},
		},
		isIdle() {
			return true;
		},
		sessionManager: {
			getBranch() {
				return structuredClone(branch);
			},
		},
		ui: {
			theme: {
				fg(_color, text) {
					return text;
				},
			},
			notify(message, level) {
				notifications.push({ message, level });
			},
			setStatus(key, value) {
				statuses.push({ key, value });
			},
		},
	};

	profileModes(pi);

	return {
		commands,
		ctx,
		handlers,
		modelChanges,
		notifications,
		sentMessages,
		statuses,
		toolChanges,
		get branch() {
			return branch;
		},
		setBranch(entries) {
			branch = structuredClone(entries);
		},
		get model() {
			return model;
		},
		get thinkingLevel() {
			return thinkingLevel;
		},
		get tools() {
			return tools;
		},
	};
}

test("parses combined profiles in either order", () => {
	assert.deepEqual(parseProfileInvocation("quick", "/read check service X"), {
		patch: { effort: "quick", readOnly: true },
		task: "check service X",
	});
	assert.deepEqual(
		parseProfileInvocation("read-off", "/deep inspect the design"),
		{
			patch: { effort: "deep", readOnly: false },
			task: "inspect the design",
		},
	);
});

test("rejects conflicting effort and access profiles", () => {
	assert.throws(
		() => parseProfileInvocation("quick", "/deep inspect this"),
		/Cannot combine \/quick and \/deep/,
	);
	assert.throws(
		() => parseProfileInvocation("read", "/read-off inspect this"),
		/Cannot combine \/read and \/read-off/,
	);
});

test("merges profile dimensions and can disable read-only access", () => {
	assert.deepEqual(mergeProfile(undefined, { readOnly: true }), {
		effort: "current",
		access: "read",
	});
	assert.deepEqual(
		mergeProfile({ effort: "quick", access: "normal" }, { readOnly: true }),
		{ effort: "quick", access: "read" },
	);
	assert.deepEqual(
		mergeProfile({ effort: "quick", access: "read" }, { readOnly: false }),
		{ effort: "quick", access: "normal" },
	);
});

test("read-only mode keeps only approved tools", () => {
	assert.deepEqual(filterReadOnlyTools(activeTools), [
		"read",
		"ffgrep",
		"web_search",
	]);
});

test("session restoration ignores malformed profile entries", () => {
	const valid = {
		type: "custom",
		customType: "profile-modes-state",
		data: {
			active: true,
			profile: { effort: "quick", access: "read" },
			baseline: {
				model: originalModel,
				thinkingLevel: "high",
				tools: activeTools,
			},
		},
	};
	const malformed = {
		type: "custom",
		customType: "profile-modes-state",
		data: { active: true, profile: { effort: "turbo" } },
	};
	assert.deepEqual(restoreProfileState([valid, malformed]), {
		profile: { effort: "quick", access: "read" },
		baseline: {
			model: originalModel,
			thinkingLevel: "high",
			tools: activeTools,
		},
	});
});

test("profile prompt makes quick override pstack while read-only stays active", () => {
	const prompt = buildProfilePrompt({ effort: "quick", access: "read" });
	assert.match(
		prompt,
		/overrides any pstack mode instruction while quick mode is active/i,
	);
	assert.match(prompt, /read-only/i);
});

test("standalone read keeps the current effort and read-off leaves the profile", async () => {
	const harness = createHarness();
	await harness.commands.get("read").handler("", harness.ctx);

	assert.equal(harness.model, originalModel);
	assert.equal(harness.thinkingLevel, "high");
	assert.deepEqual(harness.tools, ["read", "ffgrep", "web_search"]);
	const start = await harness.handlers.get("before_agent_start")(
		{ systemPrompt: "base" },
		harness.ctx,
	);
	assert.match(start.systemPrompt, /Read-only profile/);
	assert.doesNotMatch(start.systemPrompt, /Quick profile|Deep profile/);

	await harness.commands.get("read-off").handler("", harness.ctx);
	assert.equal(harness.model, originalModel);
	assert.equal(harness.thinkingLevel, "high");
	assert.deepEqual(harness.tools, activeTools);
	assert.equal(
		await harness.handlers.get("before_agent_start")(
			{ systemPrompt: "base" },
			harness.ctx,
		),
		undefined,
	);
});

test("quick read remains active after an answer settles", async () => {
	const harness = createHarness();
	await harness.commands
		.get("quick")
		.handler("/read check service X", harness.ctx);

	assert.equal(harness.model, profileModel);
	assert.equal(harness.thinkingLevel, "medium");
	assert.deepEqual(harness.tools, ["read", "ffgrep", "web_search"]);
	assert.deepEqual(harness.sentMessages, [
		{ content: "check service X", options: undefined },
	]);

	const firstStart = await harness.handlers.get("before_agent_start")(
		{ systemPrompt: "base\n\n## pstack mode is active" },
		harness.ctx,
	);
	assert.match(
		firstStart.systemPrompt,
		/overrides any pstack mode instruction/i,
	);
	assert.deepEqual(
		await harness.handlers.get("tool_call")({ toolName: "edit" }, harness.ctx),
		{
			block: true,
			reason: "Read-only profile blocked the edit tool.",
		},
	);

	await harness.handlers.get("agent_settled")?.({}, harness.ctx);
	const secondStart = await harness.handlers.get("before_agent_start")(
		{ systemPrompt: "base" },
		harness.ctx,
	);
	assert.match(secondStart.systemPrompt, /Quick profile/);
	assert.equal(harness.model, profileModel);
	assert.equal(harness.thinkingLevel, "medium");
	assert.deepEqual(harness.tools, ["read", "ffgrep", "web_search"]);
});

test("deep and read-off change both persistent dimensions", async () => {
	const harness = createHarness();
	await harness.commands.get("quick").handler("/read", harness.ctx);
	await harness.commands
		.get("deep")
		.handler("/read-off analyze this", harness.ctx);

	assert.equal(harness.thinkingLevel, "xhigh");
	assert.deepEqual(harness.tools, activeTools);
	const start = await harness.handlers.get("before_agent_start")(
		{ systemPrompt: "base" },
		harness.ctx,
	);
	assert.match(start.systemPrompt, /Use the pstack-mode skill/);
	assert.doesNotMatch(start.systemPrompt, /Read-only profile/);
});

test("profile changes persist and restore in a new extension instance", async () => {
	const first = createHarness();
	await first.commands.get("quick").handler("/read", first.ctx);
	const savedEntry = first.branch.find(
		(entry) => entry.customType === "profile-modes-state",
	);
	assert.ok(savedEntry);

	const resumed = createHarness({ initialEntries: [savedEntry] });
	await resumed.handlers.get("session_start")({}, resumed.ctx);
	assert.equal(resumed.model, profileModel);
	assert.equal(resumed.thinkingLevel, "medium");
	assert.deepEqual(resumed.tools, ["read", "ffgrep", "web_search"]);
});

test("tree navigation before the profile restores the baseline", async () => {
	const harness = createHarness();
	await harness.commands.get("quick").handler("/read", harness.ctx);
	harness.setBranch([]);
	await harness.handlers.get("session_tree")({}, harness.ctx);

	assert.equal(harness.model, originalModel);
	assert.equal(harness.thinkingLevel, "high");
	assert.deepEqual(harness.tools, activeTools);
});

test("commands without a task enter a persistent mode", async () => {
	const harness = createHarness();
	await harness.commands.get("quick").handler("", harness.ctx);
	await harness.commands.get("read").handler("", harness.ctx);

	assert.deepEqual(harness.sentMessages, []);
	assert.equal(harness.thinkingLevel, "medium");
	assert.deepEqual(harness.tools, ["read", "ffgrep", "web_search"]);
	assert.match(
		harness.notifications.at(-1).message,
		/quick\+read mode is active/i,
	);
});
