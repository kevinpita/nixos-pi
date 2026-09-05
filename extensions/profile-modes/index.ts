import {
	buildProfilePrompt,
	filterReadOnlyTools,
	isReadOnlyTool,
	mergeProfile,
	parseProfileInvocation,
	PROFILE_STATE_ENTRY,
	profileLabel,
	restoreProfileState,
	type PersistentProfileState,
	type ProfileBaseline,
	type ProfileCommand,
	type ProfilePatch,
	type ProfileSessionEntry,
	type ThinkingLevel,
	type TurnProfile,
} from "./core.ts";

const PROFILE_PROVIDER = "openai-codex";
const PROFILE_MODEL = "gpt-6-astra";

type SessionModel = {
	readonly provider: string;
	readonly id: string;
};

type ProfileContext = {
	readonly model: SessionModel | undefined;
	readonly modelRegistry: {
		find(provider: string, model: string): SessionModel | undefined;
	};
	isIdle(): boolean;
	readonly sessionManager: {
		getBranch(): ProfileSessionEntry[];
	};
	readonly ui: {
		readonly theme: {
			fg(color: string, text: string): string;
		};
		notify(message: string, level?: "info" | "warning" | "error"): void;
		setStatus(key: string, value: string | undefined): void;
	};
};

type ProfileEventMap = {
	before_agent_start: { readonly systemPrompt: string };
	tool_call: { readonly toolName: string };
	session_start: unknown;
	session_tree: unknown;
};

type ProfileModesAPI = {
	registerCommand(
		name: string,
		definition: {
			readonly description: string;
			readonly handler: (
				args: string,
				ctx: ProfileContext,
			) => void | Promise<void>;
		},
	): void;
	on<Name extends keyof ProfileEventMap>(
		name: Name,
		handler: (
			event: ProfileEventMap[Name],
			ctx: ProfileContext,
		) => unknown | Promise<unknown>,
	): void;
	appendEntry(customType: string, data: unknown): void;
	getThinkingLevel(): ThinkingLevel;
	setThinkingLevel(level: ThinkingLevel): void;
	getActiveTools(): string[];
	setActiveTools(toolNames: string[]): void;
	setModel(model: SessionModel): Promise<boolean>;
	sendUserMessage(content: string): void;
};

export default function profileModes(pi: ProfileModesAPI): void {
	let state: PersistentProfileState | undefined;

	function setStatus(ctx: ProfileContext, profile?: TurnProfile): void {
		const value = profile
			? ctx.ui.theme.fg("accent", `profile:${profileLabel(profile)}`)
			: undefined;
		ctx.ui.setStatus("profile-modes", value);
	}

	function captureBaseline(ctx: ProfileContext): ProfileBaseline {
		return {
			...(ctx.model
				? { model: { provider: ctx.model.provider, id: ctx.model.id } }
				: {}),
			thinkingLevel: pi.getThinkingLevel(),
			tools: pi.getActiveTools(),
		};
	}

	async function selectModel(
		provider: string,
		modelId: string,
		ctx: ProfileContext,
	): Promise<void> {
		const model = ctx.modelRegistry.find(provider, modelId);
		if (!model) {
			throw new Error(`Model ${provider}/${modelId} is not available.`);
		}
		if (!(await pi.setModel(model))) {
			throw new Error(`Model ${provider}/${modelId} has no available login.`);
		}
	}

	async function applyRuntime(
		next: PersistentProfileState,
		ctx: ProfileContext,
	): Promise<void> {
		if (next.profile.effort === "current") {
			if (next.baseline.model) {
				await selectModel(
					next.baseline.model.provider,
					next.baseline.model.id,
					ctx,
				);
			}
			pi.setThinkingLevel(next.baseline.thinkingLevel);
		} else {
			await selectModel(PROFILE_PROVIDER, PROFILE_MODEL, ctx);
			pi.setThinkingLevel(next.profile.effort === "quick" ? "medium" : "xhigh");
		}
		pi.setActiveTools(
			next.profile.access === "read"
				? filterReadOnlyTools(next.baseline.tools)
				: next.baseline.tools,
		);
		setStatus(ctx, next.profile);
	}

	async function restoreBaseline(
		baseline: ProfileBaseline,
		ctx: ProfileContext,
	): Promise<void> {
		if (baseline.model) {
			try {
				await selectModel(baseline.model.provider, baseline.model.id, ctx);
			} catch (error) {
				ctx.ui.notify(
					error instanceof Error ? error.message : String(error),
					"warning",
				);
			}
		}
		pi.setThinkingLevel(baseline.thinkingLevel);
		pi.setActiveTools(baseline.tools);
		setStatus(ctx);
	}

	function nextState(
		patch: ProfilePatch,
		ctx: ProfileContext,
	): PersistentProfileState {
		const baseline = state
			? {
					...state.baseline,
					tools:
						state.profile.access === "normal"
							? pi.getActiveTools()
							: state.baseline.tools,
				}
			: captureBaseline(ctx);
		return {
			profile: mergeProfile(state?.profile, patch),
			baseline,
		};
	}

	function persistProfile(next: PersistentProfileState): void {
		pi.appendEntry(PROFILE_STATE_ENTRY, {
			active: true,
			profile: next.profile,
			baseline: next.baseline,
		});
	}

	function persistInactiveProfile(): void {
		pi.appendEntry(PROFILE_STATE_ENTRY, { active: false });
	}

	async function changeProfile(
		patch: ProfilePatch,
		ctx: ProfileContext,
	): Promise<TurnProfile | undefined> {
		const previous = state;
		const next = nextState(patch, ctx);
		const leavesProfile =
			next.profile.effort === "current" && next.profile.access === "normal";
		try {
			if (leavesProfile) await restoreBaseline(next.baseline, ctx);
			else await applyRuntime(next, ctx);
		} catch (error) {
			try {
				if (previous) await applyRuntime(previous, ctx);
				else await restoreBaseline(next.baseline, ctx);
			} catch (rollbackError) {
				ctx.ui.notify(
					rollbackError instanceof Error
						? rollbackError.message
						: String(rollbackError),
					"warning",
				);
			}
			throw error;
		}
		state = leavesProfile ? undefined : next;
		if (state) persistProfile(state);
		else persistInactiveProfile();
		return state?.profile;
	}

	async function handleCommand(
		primary: ProfileCommand,
		args: string,
		ctx: ProfileContext,
	): Promise<void> {
		if (!ctx.isIdle()) {
			ctx.ui.notify(
				"Wait for the current answer before you change a profile.",
				"warning",
			);
			return;
		}

		try {
			const invocation = parseProfileInvocation(primary, args);
			if (
				!state &&
				invocation.patch.effort === undefined &&
				invocation.patch.readOnly === false
			) {
				ctx.ui.notify("Read-only mode is not active.", "info");
				if (invocation.task) pi.sendUserMessage(invocation.task);
				return;
			}

			const profile = await changeProfile(invocation.patch, ctx);
			ctx.ui.notify(
				profile
					? `${profileLabel(profile)} mode is active.`
					: "Profile mode is off.",
				"info",
			);
			if (invocation.task) pi.sendUserMessage(invocation.task);
		} catch (error) {
			ctx.ui.notify(
				error instanceof Error ? error.message : String(error),
				"error",
			);
		}
	}

	for (const command of ["quick", "deep", "read", "read-off"] as const) {
		pi.registerCommand(command, {
			description:
				command === "quick"
					? "Enter persistent GPT-6 Astra medium mode without pstack"
					: command === "deep"
						? "Enter persistent GPT-6 Astra xhigh mode with pstack"
						: command === "read"
							? "Enable the persistent read-only tool policy"
							: "Disable the read-only tool policy",
			handler: async (args, ctx) => handleCommand(command, args, ctx),
		});
	}

	pi.on("before_agent_start", (event) => {
		if (!state) return;
		const profilePrompt = buildProfilePrompt(state.profile);
		return {
			systemPrompt: `${event.systemPrompt}\n\n${profilePrompt}`,
		};
	});

	pi.on("tool_call", (event) => {
		if (state?.profile.access !== "read" || isReadOnlyTool(event.toolName)) {
			return;
		}
		return {
			block: true,
			reason: `Read-only profile blocked the ${event.toolName} tool.`,
		};
	});

	async function restoreBranch(ctx: ProfileContext): Promise<void> {
		const previous = state;
		const restored = restoreProfileState(ctx.sessionManager.getBranch());
		if (!restored) {
			state = undefined;
			if (previous) await restoreBaseline(previous.baseline, ctx);
			else setStatus(ctx);
			return;
		}

		try {
			await applyRuntime(restored, ctx);
			state = restored;
		} catch (error) {
			state = undefined;
			await restoreBaseline(restored.baseline, ctx);
			ctx.ui.notify(
				error instanceof Error ? error.message : String(error),
				"error",
			);
		}
	}

	pi.on("session_start", async (_event, ctx) => restoreBranch(ctx));
	pi.on("session_tree", async (_event, ctx) => restoreBranch(ctx));
}
