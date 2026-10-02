import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// Only getAgentDir is needed at runtime. Keep tests independent of Pi installation.
const hooks = registerHooks({
	resolve(specifier, context, nextResolve) {
		if (specifier === "@earendil-works/pi-coding-agent") {
			return {
				url: "data:text/javascript,export const getAgentDir = () => process.env.PI_FAST_TEST_DIR;",
				shortCircuit: true,
			};
		}
		return nextResolve(specifier, context);
	},
});
const { default: piFast } = await import("./index.ts");
hooks.deregister();

function harness(t, model) {
	const directory = mkdtempSync(join(tmpdir(), "pi-fast-test-"));
	const oldDirectory = process.env.PI_FAST_TEST_DIR;
	const oldState = process.env.PI_FAST_STATE;
	process.env.PI_FAST_TEST_DIR = directory;
	delete process.env.PI_FAST_STATE;
	t.after(() => {
		for (const [key, value] of [["PI_FAST_TEST_DIR", oldDirectory], ["PI_FAST_STATE", oldState]]) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		rmSync(directory, { recursive: true, force: true });
	});
	const handlers = new Map();
	const commands = new Map();
	let status;
	const ctx = {
		model,
		ui: {
			theme: { fg: (_color, text) => text },
			setStatus: (_key, text) => { status = text; },
			notify() {},
		},
	};
	piFast({
		on: (event, handler) => handlers.set(event, handler),
		registerCommand: (name, command) => commands.set(name, command),
		appendEntry() {},
	});
	return {
		request: (payload) => handlers.get("before_provider_request")({ payload }, ctx),
		toggle: () => commands.get("fast").handler("", ctx),
		status: () => status,
	};
}

for (const [provider, api, id] of [
	["openai-codex", "openai-codex-responses", "gpt-6.1-sol"],
	["openai", "openai-responses", "future-model"],
	["openai", "openai-completions", "future-model"],
]) {
	test(`requests priority without a model list for ${provider}/${api}`, (t) => {
		const h = harness(t, { provider, api, id });
		const payload = { input: "hello", service_tier: "auto" };
		assert.deepEqual(h.request(payload), { ...payload, service_tier: "default" });
		h.toggle();
		assert.equal(h.status(), "fast");
		assert.deepEqual(h.request(payload), { ...payload, service_tier: "priority" });
		assert.equal(payload.service_tier, "auto");
		h.toggle();
		assert.equal(h.request(payload).service_tier, "default");
	});
}

for (const model of [
	undefined,
	{ provider: "other", api: "openai-responses", id: "gpt-6-sol" },
	{ provider: "openai", api: "anthropic-messages", id: "gpt-6-sol" },
]) {
	test(`leaves incompatible model unchanged: ${JSON.stringify(model)}`, (t) => {
		const h = harness(t, model);
		h.toggle();
		assert.equal(h.status(), "fast (unsupported model)");
		assert.equal(h.request({ input: "hello" }), undefined);
	});
}
