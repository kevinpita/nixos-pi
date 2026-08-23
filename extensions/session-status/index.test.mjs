import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import sessionStatusExtension from "./index.ts";

function createHarness() {
	const handlers = new Map();
	let sessionName;
	const pi = {
		on(event, handler) {
			handlers.set(event, handler);
		},
		getSessionName() {
			return sessionName;
		},
	};
	const ctx = {
		cwd: "/work/nixos-config",
		isIdle: () => true,
		sessionManager: {
			getSessionFile: () => "/sessions/pi-session.jsonl",
			getSessionId: () => "session-1",
		},
	};

	return {
		ctx,
		handlers,
		pi,
		setSessionName(name) {
			sessionName = name;
		},
	};
}

async function readRecord(runtimeDir) {
	const path = join(runtimeDir, "pi-session-status", `${process.pid}.json`);
	return JSON.parse(await readFile(path, "utf8"));
}

test("publishes lifecycle and attention states for one Pi process", async (t) => {
	const runtimeDir = await mkdtemp(join(tmpdir(), "pi-session-status-test-"));
	const previousRuntimeDir = process.env.XDG_RUNTIME_DIR;
	process.env.XDG_RUNTIME_DIR = runtimeDir;
	t.after(async () => {
		if (previousRuntimeDir === undefined) delete process.env.XDG_RUNTIME_DIR;
		else process.env.XDG_RUNTIME_DIR = previousRuntimeDir;
		await rm(runtimeDir, { recursive: true, force: true });
	});

	const harness = createHarness();
	sessionStatusExtension(harness.pi);

	await harness.handlers.get("session_start")({ reason: "startup" }, harness.ctx);
	let record = await readRecord(runtimeDir);
	assert.equal(record.version, 1);
	assert.equal(record.pid, process.pid);
	assert.equal(record.sessionId, "session-1");
	assert.equal(record.label, "nixos-config");
	assert.equal(record.project, "nixos-config");
	assert.equal(record.status, "idle");
	assert.equal(record.revision, 1);
	assert.equal(typeof record.updatedAt, "number");

	await harness.handlers.get("agent_start")({}, harness.ctx);
	record = await readRecord(runtimeDir);
	assert.equal(record.status, "working");

	await harness.handlers.get("tool_call")({ toolName: "bash" }, harness.ctx);
	record = await readRecord(runtimeDir);
	assert.equal(record.status, "working");

	await harness.handlers.get("tool_call")({ toolName: "ask_user_question" }, harness.ctx);
	record = await readRecord(runtimeDir);
	assert.equal(record.status, "blocked");

	await harness.handlers.get("tool_execution_end")(
		{ toolName: "ask_user_question" },
		harness.ctx,
	);
	record = await readRecord(runtimeDir);
	assert.equal(record.status, "working");

	await harness.handlers.get("agent_settled")({}, harness.ctx);
	record = await readRecord(runtimeDir);
	assert.equal(record.status, "done");

	harness.setSessionName("Pi session bar");
	await harness.handlers.get("session_info_changed")(
		{ name: "Pi session bar" },
		harness.ctx,
	);
	record = await readRecord(runtimeDir);
	assert.equal(record.label, "Pi session bar");
	assert.equal(record.status, "done");

	await harness.handlers.get("session_shutdown")({ reason: "quit" }, harness.ctx);
	assert.equal(
		existsSync(join(runtimeDir, "pi-session-status", `${process.pid}.json`)),
		false,
	);
});
