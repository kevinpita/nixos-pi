import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
	const binDir = join(runtimeDir, "bin");
	const activeWindowPath = join(runtimeDir, "active-window.json");
	await mkdir(binDir);
	await writeFile(
		join(binDir, "hyprctl"),
		[
			`#!${process.execPath}`,
			'const { readFileSync } = require("node:fs");',
			"if (process.env.LD_LIBRARY_PATH) process.exit(1);",
			'process.stdout.write(readFileSync(process.env.PI_SESSION_STATUS_ACTIVE_WINDOW, "utf8"));',
			"",
		].join("\n"),
	);
	await chmod(join(binDir, "hyprctl"), 0o755);
	await writeFile(
		activeWindowPath,
		JSON.stringify({
			address: "0x111",
			class: "org.telegram.desktop",
			initialClass: "org.telegram.desktop",
		}),
	);

	const environmentNames = [
		"XDG_RUNTIME_DIR",
		"PATH",
		"HYPRLAND_INSTANCE_SIGNATURE",
		"TERM_PROGRAM",
		"LD_LIBRARY_PATH",
		"PI_SESSION_STATUS_ACTIVE_WINDOW",
	];
	const previousEnvironment = Object.fromEntries(
		environmentNames.map((name) => [name, process.env[name]]),
	);
	Object.assign(process.env, {
		XDG_RUNTIME_DIR: runtimeDir,
		PATH: `${binDir}:${process.env.PATH ?? ""}`,
		HYPRLAND_INSTANCE_SIGNATURE: "test-instance",
		TERM_PROGRAM: "ghostty",
		LD_LIBRARY_PATH: "/incompatible-gcc",
		PI_SESSION_STATUS_ACTIVE_WINDOW: activeWindowPath,
	});
	t.after(async () => {
		for (const name of environmentNames) {
			const previous = previousEnvironment[name];
			if (previous === undefined) delete process.env[name];
			else process.env[name] = previous;
		}
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
	assert.equal(record.windowAddress, undefined);
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

	await writeFile(
		activeWindowPath,
		JSON.stringify({
			address: "0xABCDEF",
			class: "com.mitchellh.ghostty",
			initialClass: "com.mitchellh.ghostty",
		}),
	);
	harness.setSessionName("Pi session bar");
	await harness.handlers.get("session_info_changed")(
		{ name: "Pi session bar" },
		harness.ctx,
	);
	record = await readRecord(runtimeDir);
	assert.equal(record.label, "Pi session bar");
	assert.equal(record.status, "done");
	assert.equal(record.windowAddress, "0xabcdef");

	await harness.handlers.get("session_shutdown")({ reason: "quit" }, harness.ctx);
	assert.equal(
		existsSync(join(runtimeDir, "pi-session-status", `${process.pid}.json`)),
		false,
	);

	await writeFile(
		activeWindowPath,
		JSON.stringify({
			address: "0x222",
			class: "com.mitchellh.ghostty",
			initialClass: "com.mitchellh.ghostty",
		}),
	);
	const startupHarness = createHarness();
	sessionStatusExtension(startupHarness.pi);
	await startupHarness.handlers
		.get("session_start")({ reason: "startup" }, startupHarness.ctx);
	record = await readRecord(runtimeDir);
	assert.equal(record.windowAddress, "0x222");
	await startupHarness.handlers
		.get("session_shutdown")({ reason: "quit" }, startupHarness.ctx);
});
