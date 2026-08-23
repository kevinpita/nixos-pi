import assert from "node:assert/strict";
import test from "node:test";
import {
	extractGitReferenceToken,
	filterGitReferences,
	formatGitReference,
	parseBranchRefs,
	parsePullRequests,
} from "./core.ts";

function branchLine({
	fullName,
	name,
	head = " ",
	upstream = "",
	worktree = "",
	committedAt,
	commit,
	subject,
}) {
	return [
		fullName,
		name,
		head,
		upstream,
		worktree,
		String(committedAt),
		commit,
		subject,
	].join("\t");
}

test("extracts mixed, branch, and pull-request autocomplete tokens", () => {
	assert.deepEqual(extractGitReferenceToken("Compare @git:"), {
		prefix: "@git:",
		mode: "all",
		query: "",
	});
	assert.deepEqual(extractGitReferenceToken("Compare @git:branch:login"), {
		prefix: "@git:branch:login",
		mode: "branches",
		query: "login",
	});
	assert.deepEqual(extractGitReferenceToken("Review @git:pr:184"), {
		prefix: "@git:pr:184",
		mode: "pullRequests",
		query: "184",
	});
	assert.equal(extractGitReferenceToken("email@example.com"), undefined);
	assert.equal(extractGitReferenceToken("prefix@git:branch:main"), undefined);
});

test("parses, sorts, and de-duplicates local and remote branches", () => {
	const output = [
		branchLine({
			fullName: "refs/remotes/origin/feature/remote-only",
			name: "origin/feature/remote-only",
			committedAt: 400,
			commit: "dddd444",
			subject: "Remote work",
		}),
		branchLine({
			fullName: "refs/heads/feature/local",
			name: "feature/local",
			committedAt: 300,
			commit: "cccc333",
			subject: "Local work",
		}),
		branchLine({
			fullName: "refs/remotes/origin/main",
			name: "origin/main",
			committedAt: 200,
			commit: "bbbb222",
			subject: "Tracked duplicate",
		}),
		branchLine({
			fullName: "refs/heads/main",
			name: "main",
			head: "*",
			upstream: "origin/main",
			worktree: "/work/project",
			committedAt: 200,
			commit: "aaaa111",
			subject: "Current work",
		}),
		branchLine({
			fullName: "refs/remotes/origin/HEAD",
			name: "origin",
			committedAt: 200,
			commit: "aaaa111",
			subject: "Remote head",
		}),
	].join("\n");

	const branches = parseBranchRefs(output);
	assert.deepEqual(
		branches.map((branch) => branch.name),
		["main", "feature/local", "origin/feature/remote-only"],
	);
	assert.equal(branches[0].current, true);
	assert.equal(branches[0].upstream, "origin/main");
	assert.equal(branches[0].worktreePath, "/work/project");
	assert.equal(branches[2].local, false);
});

test("keeps tabs in a commit subject", () => {
	const output = branchLine({
		fullName: "refs/heads/main",
		name: "main",
		committedAt: 200,
		commit: "aaaa111",
		subject: "Subject\twith tab",
	});

	assert.equal(parseBranchRefs(output)[0].subject, "Subject\twith tab");
});

test("parses valid pull requests and skips invalid entries", () => {
	const pullRequests = parsePullRequests(
		JSON.stringify([
			{
				number: 184,
				title: "Fix login timeout",
				state: "OPEN",
				isDraft: false,
				headRefName: "feature/login",
				baseRefName: "main",
				updatedAt: "2026-08-14T08:00:00Z",
				url: "https://github.com/org/repo/pull/184",
				author: { login: "alice" },
			},
			{ number: "invalid", title: "Ignored", url: "https://example.com" },
		]),
	);

	assert.equal(pullRequests.length, 1);
	assert.deepEqual(pullRequests[0], {
		kind: "pr",
		number: 184,
		title: "Fix login timeout",
		state: "OPEN",
		isDraft: false,
		headRefName: "feature/login",
		baseRefName: "main",
		updatedAt: "2026-08-14T08:00:00Z",
		url: "https://github.com/org/repo/pull/184",
		author: "alice",
	});
});

test("rejects invalid pull-request JSON", () => {
	assert.throws(
		() => parsePullRequests("not-json"),
		/GitHub returned invalid pull-request data/,
	);
	assert.throws(
		() => parsePullRequests("{}"),
		/GitHub returned invalid pull-request data/,
	);
});

test("formats branch and pull-request references", () => {
	const [branch] = parseBranchRefs(
		branchLine({
			fullName: "refs/heads/feature/login",
			name: "feature/login",
			committedAt: 200,
			commit: "aaaa111",
			subject: "Login",
		}),
	);
	const [pullRequest] = parsePullRequests(
		JSON.stringify([
			{
				number: 184,
				title: "Fix login timeout",
				url: "https://github.com/org/repo/pull/184",
			},
		]),
	);

	assert.equal(formatGitReference(branch), "Branch 'feature/login'");
	assert.equal(
		formatGitReference(pullRequest),
		"PR '#184 (https://github.com/org/repo/pull/184)'",
	);
});

test("filters references by branch metadata and pull-request metadata", () => {
	const branches = parseBranchRefs(
		[
			branchLine({
				fullName: "refs/heads/main",
				name: "main",
				committedAt: 200,
				commit: "aaaa111",
				subject: "Base branch",
			}),
			branchLine({
				fullName: "refs/heads/feature/login",
				name: "feature/login",
				committedAt: 100,
				commit: "bbbb222",
				subject: "Fix authentication timeout",
			}),
		].join("\n"),
	);
	const pullRequests = parsePullRequests(
		JSON.stringify([
			{
				number: 184,
				title: "Fix login timeout",
				headRefName: "feature/login",
				baseRefName: "main",
				url: "https://github.com/org/repo/pull/184",
				author: { login: "alice" },
			},
		]),
	);

	assert.deepEqual(
		filterGitReferences(branches, "auth").map((reference) => reference.name),
		["feature/login"],
	);
	assert.deepEqual(
		filterGitReferences(pullRequests, "184").map(
			(reference) => reference.number,
		),
		[184],
	);
	assert.deepEqual(
		filterGitReferences(pullRequests, "alice").map(
			(reference) => reference.number,
		),
		[184],
	);
});
