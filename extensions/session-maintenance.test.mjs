import assert from "node:assert/strict";
import {
	access,
	mkdir,
	mkdtemp,
	readdir,
	stat,
	utimes,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import test from "node:test";

const script = fileURLToPath(
	new URL("../scripts/pi-session-maintenance.sh", import.meta.url),
);

async function createFile(path, content, modifiedAt) {
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, content, "utf8");
	if (modifiedAt) await utimes(path, modifiedAt, modifiedAt);
}

function run(command, args, options = {}) {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, options);
		let stdout = "";
		let stderr = "";
		child.stdout?.on("data", (chunk) => {
			stdout += chunk;
		});
		child.stderr?.on("data", (chunk) => {
			stderr += chunk;
		});
		child.on("error", reject);
		child.on("close", (status) => resolve({ status, stdout, stderr }));
	});
}

async function doesNotExist(path) {
	try {
		await access(path);
		return false;
	} catch (error) {
		if (error?.code === "ENOENT") return true;
		throw error;
	}
}

test("archives old primary sessions and removes expired child data", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-session-maintenance-test-"));
	const sessionRoot = join(root, "sessions");
	const childRoot = join(root, "child-sessions");
	const archiveRoot = join(root, "archives");
	const old = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);

	const oldPrimary = join(sessionRoot, "work-a", "old.jsonl");
	const recentPrimary = join(sessionRoot, "work-a", "recent.jsonl");
	const oldNestedChild = join(
		sessionRoot,
		"work-a",
		"parent-session",
		"run-0",
		"session.jsonl",
	);
	const oldArtifact = join(
		sessionRoot,
		"work-a",
		"parent-session",
		"subagent-artifacts",
		"result.md",
	);
	const oldSeparateChild = join(childRoot, "run-a", "session.jsonl");
	const recentSeparateChild = join(childRoot, "run-b", "session.jsonl");

	await createFile(oldPrimary, "old primary\n", old);
	await createFile(recentPrimary, "recent primary\n");
	await createFile(oldNestedChild, "old nested child\n", old);
	await createFile(oldArtifact, "old artifact\n", old);
	await createFile(oldSeparateChild, "old separate child\n", old);
	await createFile(recentSeparateChild, "recent separate child\n");

	const result = await run("bash", [script], {
		env: {
			...process.env,
			PI_SESSION_ROOT: sessionRoot,
			PI_SUBAGENT_SESSION_ROOT: childRoot,
			PI_SESSION_ARCHIVE_ROOT: archiveRoot,
			PI_PRIMARY_RETENTION_DAYS: "1",
			PI_CHILD_RETENTION_DAYS: "1",
		},
	});
	assert.equal(result.status, 0, result.stderr || result.stdout);

	assert.equal(await doesNotExist(oldPrimary), true);
	assert.equal(await doesNotExist(oldNestedChild), true);
	assert.equal(await doesNotExist(oldArtifact), true);
	assert.equal(await doesNotExist(oldSeparateChild), true);
	assert.equal(await doesNotExist(recentPrimary), false);
	assert.equal(await doesNotExist(recentSeparateChild), false);

	const archives = await readdir(archiveRoot);
	assert.equal(archives.length, 1);
	assert.match(archives[0], /^pi-sessions-.*\.tar\.zst$/);
	assert.equal((await stat(archiveRoot)).mode & 0o777, 0o700);

	const listing = await run(
		"tar",
		["--use-compress-program=unzstd", "-tf", join(archiveRoot, archives[0])],
		{},
	);
	assert.equal(listing.status, 0, listing.stderr);
	assert.equal(listing.stdout.trim(), "work-a/old.jsonl");
});

test("removes expired child sessions when no primary archive is due", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-session-maintenance-test-"));
	const sessionRoot = join(root, "sessions");
	const childRoot = join(root, "child-sessions");
	const archiveRoot = join(root, "archives");
	const old = new Date(Date.now() - (30 * 24 + 1) * 60 * 60 * 1000);
	const child = join(
		sessionRoot,
		"work-a",
		"parent-session",
		"run-0",
		"session.jsonl",
	);
	await createFile(child, "old child\n", old);

	const result = await run("bash", [script], {
		env: {
			...process.env,
			PI_SESSION_ROOT: sessionRoot,
			PI_SUBAGENT_SESSION_ROOT: childRoot,
			PI_SESSION_ARCHIVE_ROOT: archiveRoot,
			PI_PRIMARY_RETENTION_DAYS: "90",
			PI_CHILD_RETENTION_DAYS: "30",
		},
	});
	assert.equal(result.status, 0, result.stderr || result.stdout);
	assert.equal(await doesNotExist(child), true);
	assert.equal(await doesNotExist(archiveRoot), true);
});
