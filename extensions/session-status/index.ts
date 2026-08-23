import { mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

type SessionStatus = "idle" | "working" | "blocked" | "done";

type SessionContext = {
	readonly cwd: string;
	isIdle(): boolean;
	readonly sessionManager: {
		getSessionFile(): string | undefined;
		getSessionId(): string;
	};
};

type EventMap = {
	readonly session_start: { readonly reason: string };
	readonly session_info_changed: { readonly name?: string };
	readonly agent_start: unknown;
	readonly agent_settled: unknown;
	readonly tool_call: { readonly toolName: string };
	readonly tool_execution_end: { readonly toolName: string };
	readonly session_shutdown: { readonly reason: string };
};

type SessionStatusExtensionAPI = {
	getSessionName(): string | undefined;
	on<Name extends keyof EventMap>(
		event: Name,
		handler: (event: EventMap[Name], ctx: SessionContext) => void,
	): void;
};

type SessionRecord = {
	readonly version: 1;
	readonly pid: number;
	readonly sessionId: string;
	readonly sessionFile?: string;
	readonly label: string;
	readonly status: SessionStatus;
	readonly project: string;
	readonly cwd: string;
	readonly revision: number;
	readonly updatedAt: number;
};

const ATTENTION_TOOLS = new Set(["ask_user_question"]);

function normalizeName(name: string | undefined): string | undefined {
	const normalized = name?.trim();
	return normalized ? normalized : undefined;
}

function runtimeDirectory(): string {
	const configured = process.env.XDG_RUNTIME_DIR?.trim();
	if (configured) return configured;
	return join("/run/user", process.getuid().toString());
}

export default function (pi: SessionStatusExtensionAPI): void {
	let status: SessionStatus = "idle";
	let revision = 0;
	let sessionName: string | undefined;
	let recordPath: string | undefined;

	function publish(ctx: SessionContext, nextStatus: SessionStatus): void {
		status = nextStatus;
		revision += 1;

		const directory = join(runtimeDirectory(), "pi-session-status");
		const path = join(directory, `${process.pid}.json`);
		const temporaryPath = `${path}.${revision}.tmp`;
		const project = basename(ctx.cwd) || ctx.cwd;
		const label = sessionName ?? (project || `Pi ${process.pid}`);
		const record: SessionRecord = {
			version: 1,
			pid: process.pid,
			sessionId: ctx.sessionManager.getSessionId(),
			sessionFile: ctx.sessionManager.getSessionFile(),
			label,
			status,
			project,
			cwd: ctx.cwd,
			revision,
			updatedAt: Date.now(),
		};

		try {
			mkdirSync(directory, { recursive: true, mode: 0o700 });
			writeFileSync(temporaryPath, `${JSON.stringify(record)}\n`, {
				encoding: "utf8",
				mode: 0o600,
			});
			renameSync(temporaryPath, path);
			recordPath = path;
		} catch {
			try {
				unlinkSync(temporaryPath);
			} catch {}
		}
	}

	function removeRecord(): void {
		if (!recordPath) return;
		try {
			unlinkSync(recordPath);
		} catch {}
		recordPath = undefined;
	}

	pi.on("session_start", (_event, ctx) => {
		sessionName = normalizeName(pi.getSessionName());
		publish(ctx, ctx.isIdle() ? "idle" : "working");
	});

	pi.on("session_info_changed", (event, ctx) => {
		sessionName = normalizeName(event.name);
		publish(ctx, status);
	});

	pi.on("agent_start", (_event, ctx) => {
		publish(ctx, "working");
	});

	pi.on("tool_call", (event, ctx) => {
		if (ATTENTION_TOOLS.has(event.toolName)) publish(ctx, "blocked");
	});

	pi.on("tool_execution_end", (event, ctx) => {
		if (ATTENTION_TOOLS.has(event.toolName)) publish(ctx, "working");
	});

	pi.on("agent_settled", (_event, ctx) => {
		publish(ctx, "done");
	});

	pi.on("session_shutdown", () => {
		removeRecord();
	});
}
