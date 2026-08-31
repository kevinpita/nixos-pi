export const PROFILE_STATE_ENTRY = "profile-modes-state";

export type EffortProfile = "current" | "quick" | "deep";
export type AccessProfile = "normal" | "read";
export type ProfileCommand = "quick" | "deep" | "read" | "read-off";
export type ThinkingLevel =
	| "off"
	| "minimal"
	| "low"
	| "medium"
	| "high"
	| "xhigh"
	| "max";

export interface TurnProfile {
	effort: EffortProfile;
	access: AccessProfile;
}

export interface ProfilePatch {
	effort?: Exclude<EffortProfile, "current">;
	readOnly?: boolean;
}

export interface ParsedProfileInvocation {
	patch: ProfilePatch;
	task: string;
}

export interface ModelReference {
	provider: string;
	id: string;
}

export interface ProfileBaseline {
	model?: ModelReference;
	thinkingLevel: ThinkingLevel;
	tools: string[];
}

export interface PersistentProfileState {
	profile: TurnProfile;
	baseline: ProfileBaseline;
}

export interface ProfileSessionEntry {
	type: string;
	customType?: string;
	data?: unknown;
}

const THINKING_LEVELS = new Set<ThinkingLevel>([
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
]);

const READ_ONLY_TOOL_NAMES = new Set([
	"ask_user_question",
	"ast_grep_dump",
	"ast_grep_outline",
	"ast_grep_search",
	"fetch_content",
	"fffind",
	"ffgrep",
	"find",
	"get_search_content",
	"grep",
	"lens_diagnostics",
	"lsp_diagnostics",
	"ls",
	"module_report",
	"pi_lens_activate_tools",
	"project_report",
	"read",
	"read_enclosing",
	"read_symbol",
	"source_check",
	"symbol_search",
	"web_search",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parsePersistentState(
	data: unknown,
): PersistentProfileState | undefined {
	if (!isRecord(data) || data.active !== true) return undefined;
	if (!isRecord(data.profile) || !isRecord(data.baseline)) return undefined;

	const effort = data.profile.effort;
	const access = data.profile.access;
	const thinkingLevel = data.baseline.thinkingLevel;
	const tools = data.baseline.tools;
	if (effort !== "current" && effort !== "quick" && effort !== "deep") {
		return undefined;
	}
	if (access !== "normal" && access !== "read") return undefined;
	if (
		typeof thinkingLevel !== "string" ||
		!THINKING_LEVELS.has(thinkingLevel as ThinkingLevel)
	) {
		return undefined;
	}
	if (
		!Array.isArray(tools) ||
		!tools.every((tool) => typeof tool === "string")
	) {
		return undefined;
	}

	const rawModel = data.baseline.model;
	let model: ModelReference | undefined;
	if (rawModel !== undefined) {
		if (
			!isRecord(rawModel) ||
			typeof rawModel.provider !== "string" ||
			!rawModel.provider ||
			typeof rawModel.id !== "string" ||
			!rawModel.id
		) {
			return undefined;
		}
		model = { provider: rawModel.provider, id: rawModel.id };
	}

	return {
		profile: { effort, access },
		baseline: {
			...(model ? { model } : {}),
			thinkingLevel: thinkingLevel as ThinkingLevel,
			tools: [...tools],
		},
	};
}

export function restoreProfileState(
	entries: readonly ProfileSessionEntry[],
): PersistentProfileState | undefined {
	let restored: PersistentProfileState | undefined;
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== PROFILE_STATE_ENTRY) {
			continue;
		}
		if (isRecord(entry.data) && entry.data.active === false) {
			restored = undefined;
			continue;
		}
		const candidate = parsePersistentState(entry.data);
		if (candidate) restored = candidate;
	}
	return restored;
}

export function parseProfileInvocation(
	primary: ProfileCommand,
	args: string,
): ParsedProfileInvocation {
	const commands: ProfileCommand[] = [primary];
	let task = args.trimStart();

	while (task.startsWith("/")) {
		const match = task.match(/^\/(quick|deep|read-off|read)(?:\s+|$)/);
		if (!match) break;
		commands.push(match[1] as ProfileCommand);
		task = task.slice(match[0].length).trimStart();
	}

	const efforts = new Set(
		commands.filter(
			(command): command is Exclude<EffortProfile, "current"> =>
				command === "quick" || command === "deep",
		),
	);
	if (efforts.size > 1) {
		throw new Error("Cannot combine /quick and /deep in one command.");
	}
	if (commands.includes("read") && commands.includes("read-off")) {
		throw new Error("Cannot combine /read and /read-off in one command.");
	}

	const effort = [...efforts][0];
	const readOnly = commands.includes("read")
		? true
		: commands.includes("read-off")
			? false
			: undefined;
	return {
		patch: {
			...(effort ? { effort } : {}),
			...(readOnly === undefined ? {} : { readOnly }),
		},
		task: task.trim(),
	};
}

export function mergeProfile(
	current: TurnProfile | undefined,
	patch: ProfilePatch,
): TurnProfile {
	return {
		effort: patch.effort ?? current?.effort ?? "current",
		access:
			patch.readOnly === undefined
				? (current?.access ?? "normal")
				: patch.readOnly
					? "read"
					: "normal",
	};
}

export function isReadOnlyTool(toolName: string): boolean {
	return READ_ONLY_TOOL_NAMES.has(toolName);
}

export function filterReadOnlyTools(toolNames: readonly string[]): string[] {
	return toolNames.filter(isReadOnlyTool);
}

export function profileLabel(profile: TurnProfile): string {
	if (profile.effort === "current") {
		return profile.access === "read" ? "read" : "current";
	}
	const parts: string[] = [profile.effort];
	if (profile.access === "read") parts.push("read");
	return parts.join("+");
}

export function buildProfilePrompt(profile: TurnProfile): string {
	const sections: string[] = [];

	if (profile.effort === "quick") {
		sections.push(`## Quick profile

This profile overrides any pstack mode instruction while quick mode is active. Do not load or use pstack-mode unless the user explicitly requests it in the current task.

Use the smallest direct path that answers the request. Skills remain available. Use a skill or tool only when it directly helps. Do not create a task plan or delegate work unless the user requests it.`);
	}

	if (profile.effort === "deep") {
		sections.push(`## Deep profile

Use the pstack-mode skill for every non-trivial task. Read its SKILL.md before you plan or change files. Match one playbook and follow all gates. For a small conversational request, answer directly.

Configured model roles:
- analysis: openai-codex/gpt-5.6-sol:xhigh
- implementation: openai-codex/gpt-5.6-sol:xhigh
- review: openai-codex/gpt-5.6-sol:xhigh`);
	}

	if (profile.access === "read") {
		sections.push(`## Read-only profile

This is a read-only task. Examine and report. Do not change files, repositories, session task state, terminal state, or remote systems. Only the approved read-only tools are available. If the task requires a change, explain what must change and stop.`);
	}

	return sections.join("\n\n");
}
