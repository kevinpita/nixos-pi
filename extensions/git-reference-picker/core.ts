export type GitBranch = {
	kind: "branch";
	name: string;
	fullName: string;
	local: boolean;
	current: boolean;
	upstream?: string;
	worktreePath?: string;
	committedAt: number;
	commit: string;
	subject: string;
};

export type GitPullRequest = {
	kind: "pr";
	number: number;
	title: string;
	state: string;
	isDraft: boolean;
	headRefName: string;
	baseRefName: string;
	updatedAt: string;
	url: string;
	author?: string;
};

export type GitReference = GitBranch | GitPullRequest;
export type GitReferenceMode = "branches" | "pullRequests" | "all";
export type GitReferenceToken = {
	prefix: string;
	mode: GitReferenceMode;
	query: string;
};

const BRANCH_FIELD_COUNT = 8;

export function extractGitReferenceToken(
	textBeforeCursor: string,
): GitReferenceToken | undefined {
	const match = textBeforeCursor.match(/(?:^|[ \t])(@git:([^\s]*))$/);
	if (!match) return undefined;

	const prefix = match[1];
	const token = match[2] ?? "";
	if (token === "branch" || token.startsWith("branch:")) {
		return {
			prefix,
			mode: "branches",
			query: token === "branch" ? "" : token.slice("branch:".length),
		};
	}
	if (token === "pr" || token.startsWith("pr:")) {
		return {
			prefix,
			mode: "pullRequests",
			query: token === "pr" ? "" : token.slice("pr:".length),
		};
	}
	return { prefix, mode: "all", query: token };
}

function optional(value: string): string | undefined {
	const normalized = value.trim();
	return normalized || undefined;
}

function compareBranches(left: GitBranch, right: GitBranch): number {
	if (left.current !== right.current) return left.current ? -1 : 1;
	if (left.local !== right.local) return left.local ? -1 : 1;
	if (left.committedAt !== right.committedAt) {
		return right.committedAt - left.committedAt;
	}
	return left.name.localeCompare(right.name);
}

export function parseBranchRefs(output: string): GitBranch[] {
	const branches: GitBranch[] = [];

	for (const rawLine of output.split("\n")) {
		if (!rawLine) continue;
		const fields = rawLine.replace(/\r$/, "").split("\t");
		if (fields.length < BRANCH_FIELD_COUNT) continue;

		const [fullName, name, head, upstream, worktreePath, committedAt, commit] =
			fields;
		if (!fullName || !name || !commit) continue;
		if (fullName.startsWith("refs/remotes/") && fullName.endsWith("/HEAD")) {
			continue;
		}

		branches.push({
			kind: "branch",
			name,
			fullName,
			local: fullName.startsWith("refs/heads/"),
			current: head.trim() === "*",
			upstream: optional(upstream),
			worktreePath: optional(worktreePath),
			committedAt: Number.parseInt(committedAt, 10) || 0,
			commit,
			subject: fields.slice(7).join("\t").trim(),
		});
	}

	const trackedRemotes = new Set(
		branches
			.filter((branch) => branch.local && branch.upstream)
			.map((branch) => branch.upstream as string),
	);

	return branches
		.filter((branch) => branch.local || !trackedRemotes.has(branch.name))
		.sort(compareBranches);
}

type PullRequestJson = {
	number?: unknown;
	title?: unknown;
	state?: unknown;
	isDraft?: unknown;
	headRefName?: unknown;
	baseRefName?: unknown;
	updatedAt?: unknown;
	url?: unknown;
	author?: { login?: unknown } | null;
};

function stringValue(value: unknown): string {
	return typeof value === "string" ? value : "";
}

export function parsePullRequests(output: string): GitPullRequest[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(output);
	} catch {
		throw new Error("GitHub returned invalid pull-request data");
	}
	if (!Array.isArray(parsed)) {
		throw new Error("GitHub returned invalid pull-request data");
	}

	return parsed.flatMap((value): GitPullRequest[] => {
		if (!value || typeof value !== "object") return [];
		const item = value as PullRequestJson;
		if (
			typeof item.number !== "number" ||
			!Number.isInteger(item.number) ||
			typeof item.title !== "string" ||
			typeof item.url !== "string"
		) {
			return [];
		}

		return [
			{
				kind: "pr",
				number: item.number,
				title: item.title,
				state: stringValue(item.state),
				isDraft: item.isDraft === true,
				headRefName: stringValue(item.headRefName),
				baseRefName: stringValue(item.baseRefName),
				updatedAt: stringValue(item.updatedAt),
				url: item.url,
				author:
					item.author && typeof item.author.login === "string"
						? item.author.login
						: undefined,
			},
		];
	});
}

function escapeSingleQuotes(value: string): string {
	return value.replaceAll("'", "\\'");
}

export function formatGitReference(reference: GitReference): string {
	if (reference.kind === "branch") {
		return `Branch '${escapeSingleQuotes(reference.name)}'`;
	}
	return `PR '#${reference.number} (${escapeSingleQuotes(reference.url)})'`;
}

function gitReferenceSearchText(reference: GitReference): string {
	if (reference.kind === "branch") {
		return [
			reference.name,
			reference.upstream,
			reference.commit,
			reference.subject,
			reference.local ? "local" : "remote",
		]
			.filter(Boolean)
			.join(" ");
	}

	return [
		`#${reference.number}`,
		String(reference.number),
		reference.title,
		reference.headRefName,
		reference.baseRefName,
		reference.author,
		reference.state,
		reference.isDraft ? "draft" : undefined,
	]
		.filter(Boolean)
		.join(" ");
}

// References are parsed once and then filtered on every keystroke, so cache
// their lowercased search text by object identity.
const searchTextCache = new WeakMap<GitReference, string>();

function lowerSearchText(reference: GitReference): string {
	let text = searchTextCache.get(reference);
	if (text === undefined) {
		text = gitReferenceSearchText(reference).toLowerCase();
		searchTextCache.set(reference, text);
	}
	return text;
}

function fuzzyScore(
	normalizedText: string,
	normalizedQuery: string,
): number | undefined {
	const directIndex = normalizedText.indexOf(normalizedQuery);
	if (directIndex >= 0) return directIndex;

	let textIndex = 0;
	let gapScore = normalizedText.length;
	for (const character of normalizedQuery) {
		const matchIndex = normalizedText.indexOf(character, textIndex);
		if (matchIndex < 0) return undefined;
		gapScore += matchIndex - textIndex;
		textIndex = matchIndex + 1;
	}
	return gapScore;
}

export function filterGitReferences<T extends GitReference>(
	references: readonly T[],
	query: string,
	limit = 100,
): T[] {
	const normalizedQuery = query.trim();
	if (!normalizedQuery) return references.slice(0, limit);

	const loweredQuery = normalizedQuery.toLowerCase();
	return references
		.map((reference, index) => ({
			reference,
			index,
			score: fuzzyScore(lowerSearchText(reference), loweredQuery),
		}))
		.filter(
			(item): item is { reference: T; index: number; score: number } =>
				item.score !== undefined,
		)
		.sort((left, right) => left.score - right.score || left.index - right.index)
		.slice(0, limit)
		.map((item) => item.reference);
}
