export const MIN_SPLIT_SESSIONS = 2;
export const MAX_SPLIT_SESSIONS = 12;

const MAX_TAB_LABEL_LENGTH = 64;
const MAX_AGENT_NAME_LENGTH = 32;

export function parseSplitCount(raw: string): number {
	const value = raw.trim();
	if (!/^\d+$/.test(value)) {
		throw new Error("Usage: /split <total-sessions> [prompt]");
	}

	const count = Number.parseInt(value, 10);
	if (count < MIN_SPLIT_SESSIONS || count > MAX_SPLIT_SESSIONS) {
		throw new Error(
			`Split count must be between ${MIN_SPLIT_SESSIONS} and ${MAX_SPLIT_SESSIONS}`,
		);
	}

	return count;
}

export function parseSplitArgs(raw: string): {
	readonly count: number;
	readonly prompt?: string;
} {
	const value = raw.trim();
	const separator = value.search(/\s/);
	const count = parseSplitCount(
		separator === -1 ? value : value.slice(0, separator),
	);
	const prompt = separator === -1 ? "" : value.slice(separator).trim();
	return prompt ? { count, prompt } : { count };
}

export function expandSplitPrompt(prompt: string, index: number): string {
	return prompt.replaceAll("$i", String(index));
}

function normalizeLabel(value: string | undefined): string {
	return (value ?? "")
		.replace(/[\u0000-\u001f\u007f]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

export function buildSplitLabel(
	parentName: string | undefined,
	index: number,
	total: number,
): string {
	const suffix = ` ${index}/${total}`;
	const base = normalizeLabel(parentName) || "split";
	const available = Math.max(1, MAX_TAB_LABEL_LENGTH - suffix.length);
	return `${base.slice(0, available).trimEnd()}${suffix}`;
}

function namePart(value: string, length: number, fromEnd = false): string {
	const normalized = value.toLowerCase().replace(/[^a-z0-9]+/g, "");
	return fromEnd ? normalized.slice(-length) : normalized.slice(0, length);
}

export function buildAgentName(
	sessionId: string,
	runToken: string,
	index: number,
): string {
	const sessionPart = namePart(sessionId, 8) || "session";
	const runPart = namePart(runToken, 8, true) || "run";
	const name = `split-${sessionPart}-${runPart}-${index}`;
	return name.slice(0, MAX_AGENT_NAME_LENGTH).replace(/-+$/g, "");
}

type SplitSessionEntry = {
	readonly type: string;
	readonly message?: { readonly role?: string };
};

export function selectSplitBranch<T extends SplitSessionEntry>(
	branch: readonly T[],
	isActive: boolean,
): T[] {
	if (isActive) {
		for (let index = branch.length - 1; index >= 0; index -= 1) {
			const entry = branch[index];
			if (entry?.type === "message" && entry.message?.role === "user") {
				return branch.slice(0, index);
			}
		}
	}
	return [...branch];
}

export function buildPiSessionArgs(
	sessionFile: string,
	label: string,
	prompt?: string,
): string[] {
	const args = ["--session", sessionFile, "--name", label];
	if (prompt) args.push(prompt);
	return args;
}
