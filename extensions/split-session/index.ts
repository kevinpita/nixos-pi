import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	buildAgentName,
	buildPiSessionArgs,
	buildSplitLabel,
	expandSplitPrompt,
	parseSplitArgs,
	selectSplitBranch,
} from "./core.ts";

const AGENT_START_TIMEOUT_MS = 60_000;
const EXEC_TIMEOUT_PADDING_MS = 5_000;

type PiExecResult = {
	readonly code: number;
	readonly stdout: string;
	readonly stderr: string;
};

type SessionEntry = {
	readonly type: string;
	readonly id: string;
	readonly parentId: string | null;
	readonly message?: { readonly role?: string };
};

type SessionManager = {
	getSessionFile(): string | undefined;
	getSessionDir(): string;
	getSessionId(): string;
	getHeader(): { readonly version?: number } | null;
	getBranch(): SessionEntry[];
};

type ExtensionCommandContext = {
	readonly cwd: string;
	readonly sessionManager: SessionManager;
	readonly ui: {
		notify(message: string, type?: "info" | "warning" | "error"): void;
		setStatus(key: string, text: string | undefined): void;
	};
	isIdle(): boolean;
};

type ExtensionAPI = {
	exec(
		command: string,
		args: string[],
		options?: { readonly timeout?: number },
	): Promise<PiExecResult>;
	getSessionName(): string | undefined;
	sendUserMessage(
		content: string,
		options?: { readonly deliverAs: "followUp" },
	): void;
	registerCommand(
		name: string,
		options: {
			readonly description?: string;
			readonly handler: (
				args: string,
				ctx: ExtensionCommandContext,
			) => Promise<void> | void;
		},
	): void;
};

type HerdrPane = {
	readonly pane_id: string;
	readonly workspace_id: string;
};

type HerdrTab = {
	readonly tab_id: string;
};

type HerdrEnvelope<T> = {
	readonly result?: T;
	readonly error?: {
		readonly code?: string;
		readonly message?: string;
	};
};

type CreatedTab = {
	readonly index: number;
	readonly label: string;
	readonly tab: HerdrTab;
	readonly pane: HerdrPane;
	readonly agentName: string;
	readonly sessionFile: string;
};

function parseHerdrFailure(output: string): string | undefined {
	const trimmed = output.trim();
	if (!trimmed) return undefined;

	try {
		const envelope = JSON.parse(trimmed) as HerdrEnvelope<unknown>;
		return envelope.error?.message ?? envelope.error?.code ?? trimmed;
	} catch {
		return trimmed;
	}
}

async function runHerdr<T>(
	pi: ExtensionAPI,
	args: string[],
	timeout: number,
): Promise<T> {
	const result = await pi.exec("herdr", args, { timeout });
	if (result.code !== 0) {
		const failure =
			parseHerdrFailure(result.stderr) ??
			parseHerdrFailure(result.stdout) ??
			`herdr ${args.join(" ")} exited with code ${result.code}`;
		throw new Error(failure);
	}

	let envelope: HerdrEnvelope<T>;
	try {
		envelope = JSON.parse(result.stdout) as HerdrEnvelope<T>;
	} catch {
		throw new Error(`herdr ${args.join(" ")} returned invalid JSON`);
	}

	if (envelope.error) {
		throw new Error(
			envelope.error.message ??
				envelope.error.code ??
				`herdr ${args.join(" ")} failed`,
		);
	}
	if (envelope.result === undefined) {
		throw new Error(`herdr ${args.join(" ")} returned no result`);
	}

	return envelope.result;
}

function runToken(sequence: number): string {
	return `${Date.now().toString(36)}-${sequence.toString(36)}`;
}

function failureMessage(reason: unknown): string {
	return reason instanceof Error ? reason.message : String(reason);
}

async function createTab(
	pi: ExtensionAPI,
	workspaceId: string,
	cwd: string,
	label: string,
): Promise<{ tab: HerdrTab; root_pane: HerdrPane }> {
	return runHerdr(
		pi,
		[
			"tab",
			"create",
			"--workspace",
			workspaceId,
			"--cwd",
			cwd,
			"--label",
			label,
			"--no-focus",
		],
		10_000,
	);
}

async function startPi(
	pi: ExtensionAPI,
	created: CreatedTab,
	prompt?: string,
): Promise<void> {
	await runHerdr(
		pi,
		[
			"agent",
			"start",
			created.agentName,
			"--kind",
			"pi",
			"--pane",
			created.pane.pane_id,
			"--timeout",
			String(AGENT_START_TIMEOUT_MS),
			"--",
			...buildPiSessionArgs(created.sessionFile, created.label, prompt),
		],
		AGENT_START_TIMEOUT_MS + EXEC_TIMEOUT_PADDING_MS,
	);
}

function createSplitSessionFile(
	ctx: ExtensionCommandContext,
	parentSession: string,
	entries: readonly SessionEntry[],
): string {
	const timestamp = new Date().toISOString();
	const sessionId = randomUUID();
	const fileTimestamp = timestamp.replace(/[:.]/g, "-");
	const sessionFile = join(
		ctx.sessionManager.getSessionDir(),
		`${fileTimestamp}_${sessionId}.jsonl`,
	);
	const header = {
		type: "session",
		version: ctx.sessionManager.getHeader()?.version ?? 3,
		id: sessionId,
		timestamp,
		cwd: ctx.cwd,
		parentSession,
	};
	const content = [header, ...entries]
		.map((entry) => JSON.stringify(entry))
		.join("\n");
	writeFileSync(sessionFile, `${content}\n`, { flag: "wx" });
	return sessionFile;
}

async function splitSession(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	count: number,
	prompt: string | undefined,
	sequence: number,
): Promise<void> {
	const parentSession = ctx.sessionManager.getSessionFile();
	if (!parentSession) {
		throw new Error(
			"The current Pi session is not persisted and cannot be forked",
		);
	}
	const branch = selectSplitBranch(
		ctx.sessionManager.getBranch(),
		!ctx.isIdle(),
	);

	const current = await runHerdr<{ pane: HerdrPane }>(
		pi,
		["pane", "current", "--current"],
		5_000,
	);
	const sessionId = ctx.sessionManager.getSessionId();
	const token = runToken(sequence);
	const parentName = pi.getSessionName();
	const requested = count - 1;
	const created: CreatedTab[] = [];
	const failures: string[] = [];
	let started = 0;

	ctx.ui.setStatus("split-session", `Starting ${requested} Pi tabs`);
	try {
		for (let index = 2; index <= count; index++) {
			const label = buildSplitLabel(parentName, index, count);
			try {
				const result = await createTab(
					pi,
					current.pane.workspace_id,
					ctx.cwd,
					label,
				);
				created.push({
					index,
					label,
					tab: result.tab,
					pane: result.root_pane,
					agentName: buildAgentName(sessionId, token, index),
					sessionFile: createSplitSessionFile(ctx, parentSession, branch),
				});
			} catch (error) {
				failures.push(`tab ${index}: ${failureMessage(error)}`);
				break;
			}
		}

		const starts = await Promise.allSettled(
			created.map((tab) =>
				startPi(
					pi,
					tab,
					prompt === undefined ? undefined : expandSplitPrompt(prompt, tab.index),
				),
			),
		);
		starts.forEach((result, index) => {
			if (result.status === "rejected") {
				const tab = created[index];
				failures.push(
					`tab ${tab?.index ?? index + 2}: ${failureMessage(result.reason)}`,
				);
			}
		});

		started = starts.filter((result) => result.status === "fulfilled").length;
		if (failures.length > 0) {
			ctx.ui.notify(
				`Split started ${started}/${requested} Pi tabs. ${failures.join("; ")}`,
				"error",
			);
		} else {
			ctx.ui.notify(
				`Created ${started} forked Pi tabs in ${ctx.cwd}. All tabs share this working directory.`,
				"warning",
			);
		}
	} finally {
		ctx.ui.setStatus("split-session", undefined);
	}

	if (prompt !== undefined && started > 0) {
		const currentPrompt = expandSplitPrompt(prompt, 1);
		if (ctx.isIdle()) {
			pi.sendUserMessage(currentPrompt);
		} else {
			pi.sendUserMessage(currentPrompt, { deliverAs: "followUp" });
		}
	}
}

export default function (pi: ExtensionAPI): void {
	let sequence = 0;

	pi.registerCommand("split", {
		description: "Open N total forked Pi sessions and optionally run a prompt",
		handler: async (args, ctx) => {
			let request: ReturnType<typeof parseSplitArgs>;
			try {
				request = parseSplitArgs(args);
			} catch (error) {
				ctx.ui.notify(failureMessage(error), "error");
				return;
			}

			sequence += 1;
			try {
				await splitSession(pi, ctx, request.count, request.prompt, sequence);
			} catch (error) {
				ctx.ui.setStatus("split-session", undefined);
				ctx.ui.notify(
					`Unable to split the current session: ${failureMessage(error)}`,
					"error",
				);
			}
		},
	});
}
