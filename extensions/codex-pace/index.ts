import {
	assessCodexPace,
	createTodayBaseline,
	formatPaceStatus,
	parseCodexQuota,
	parseDailyUsage,
	type PaceAssessment,
	type PaceVerdict,
	type TodayBaseline,
} from "./core.ts";

const STATUS_ID = "codex-pace";
const CODEX_PROVIDER = "openai-codex";
const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const DAILY_USAGE_URL =
	"https://chatgpt.com/backend-api/wham/usage/daily-token-usage-breakdown";
const REFRESH_INTERVAL_MS = 5 * 60 * 1_000;
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 128 * 1_024;

type Model = {
	readonly provider: string;
	readonly baseUrl: string;
};

type ProviderAuth = {
	readonly apiKey?: string;
	readonly headers?: Record<string, string | null>;
	readonly baseUrl?: string;
};

type ExtensionContext = {
	readonly hasUI: boolean;
	readonly model?: Model;
	readonly modelRegistry: {
		getProviderAuth(
			providerId: string,
		): Promise<{ readonly auth: ProviderAuth } | undefined>;
	};
	readonly ui: {
		readonly theme: {
			fg(color: "dim" | "success" | "warning", text: string): string;
		};
		notify(message: string, level: "warning"): void;
		setStatus(id: string, text: string | undefined): void;
	};
};

type ExtensionAPI = {
	on(
		event:
			| "session_start"
			| "session_tree"
			| "turn_end"
			| "model_select"
			| "session_shutdown",
		handler: (event: unknown, ctx: ExtensionContext) => void | Promise<void>,
	): void;
};

type RuntimeState = {
	sessionActive: boolean;
	generation: number;
	lastFetchAt: number;
	refreshTimer?: ReturnType<typeof setTimeout>;
	requestController?: AbortController;
	todayBaseline?: TodayBaseline;
	lastVerdict?: PaceVerdict;
};

type ActiveRequest = {
	readonly generation: number;
	readonly controller: AbortController;
	readonly timeout: ReturnType<typeof setTimeout>;
};

export default function codexPaceExtension(pi: ExtensionAPI): void {
	const state: RuntimeState = {
		sessionActive: false,
		generation: 0,
		lastFetchAt: 0,
	};
	// The status bar is filled in asynchronously via ctx.ui.setStatus, so no
	// handler needs to block on the ChatGPT usage requests.
	pi.on("session_start", (_event, ctx) => {
		startSession(state);
		void refresh(state, ctx, true);
	});
	pi.on("session_tree", (_event, ctx) => {
		void refresh(state, ctx, true);
	});
	pi.on("model_select", (_event, ctx) => {
		void refresh(state, ctx, true);
	});
	pi.on("turn_end", (_event, ctx) => {
		void refresh(state, ctx, false);
	});
	pi.on("session_shutdown", (_event, ctx) => {
		stopSession(state, ctx);
	});
}

function cancelInFlight(state: RuntimeState): void {
	state.generation += 1;
	state.requestController?.abort();
	state.requestController = undefined;
	clearRefreshTimer(state);
}

function startSession(state: RuntimeState): void {
	state.sessionActive = true;
	state.lastFetchAt = 0;
	state.todayBaseline = undefined;
	state.lastVerdict = undefined;
	cancelInFlight(state);
}

function stopSession(state: RuntimeState, ctx: ExtensionContext): void {
	state.sessionActive = false;
	cancelInFlight(state);
	safeSetStatus(ctx, undefined);
}

async function refresh(
	state: RuntimeState,
	ctx: ExtensionContext,
	force: boolean,
): Promise<void> {
	if (!state.sessionActive || !ctx.hasUI) return;
	if (!isOfficialCodexModel(ctx.model)) {
		deactivatePace(state, ctx);
		return;
	}
	const now = Date.now();
	if (!force && now - state.lastFetchAt < REFRESH_INTERVAL_MS) return;
	const request = startRequest(state, now);
	try {
		const assessment = await loadAssessment(
			state,
			ctx,
			request.controller.signal,
		);
		if (!requestIsCurrent(state, request)) return;
		if (publish(state, ctx, assessment)) scheduleRefresh(state, ctx);
	} catch (error) {
		if (shouldRetry(state, request, error)) scheduleRefresh(state, ctx);
	} finally {
		finishRequest(state, request);
	}
}

function startRequest(state: RuntimeState, now: number): ActiveRequest {
	state.lastFetchAt = now;
	state.generation += 1;
	state.requestController?.abort();
	const controller = new AbortController();
	state.requestController = controller;
	return {
		generation: state.generation,
		controller,
		timeout: setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS),
	};
}

function finishRequest(state: RuntimeState, request: ActiveRequest): void {
	clearTimeout(request.timeout);
	if (state.requestController === request.controller) {
		state.requestController = undefined;
	}
}

async function loadAssessment(
	state: RuntimeState,
	ctx: ExtensionContext,
	signal: AbortSignal,
): Promise<PaceAssessment> {
	const headers = await resolveHeaders(ctx);
	const [usagePayload, dailyPayload] = await Promise.all([
		fetchJson(USAGE_URL, headers, signal),
		fetchJson(DAILY_USAGE_URL, headers, signal),
	]);
	const snapshot = {
		nowMs: Date.now(),
		quota: parseCodexQuota(usagePayload),
		dailyUsage: parseDailyUsage(dailyPayload),
	};
	const candidateBaseline = createTodayBaseline(snapshot);
	if (
		state.todayBaseline?.date !== candidateBaseline.date ||
		state.todayBaseline.resetAtMs !== candidateBaseline.resetAtMs
	) {
		state.todayBaseline = candidateBaseline;
	}
	return assessCodexPace({ ...snapshot, todayBaseline: state.todayBaseline });
}

function requestIsCurrent(
	state: RuntimeState,
	request: ActiveRequest,
): boolean {
	return (
		state.sessionActive &&
		!request.controller.signal.aborted &&
		request.generation === state.generation
	);
}

function shouldRetry(
	state: RuntimeState,
	request: ActiveRequest,
	error: unknown,
): boolean {
	return (
		!request.controller.signal.aborted &&
		!isStaleContextError(error) &&
		state.sessionActive &&
		request.generation === state.generation
	);
}

function deactivatePace(state: RuntimeState, ctx: ExtensionContext): void {
	cancelInFlight(state);
	safeSetStatus(ctx, undefined);
}

function clearRefreshTimer(state: RuntimeState): void {
	if (state.refreshTimer) clearTimeout(state.refreshTimer);
	state.refreshTimer = undefined;
}

function scheduleRefresh(state: RuntimeState, ctx: ExtensionContext): void {
	clearRefreshTimer(state);
	const scheduledGeneration = state.generation;
	state.refreshTimer = setTimeout(() => {
		state.refreshTimer = undefined;
		if (!state.sessionActive || scheduledGeneration !== state.generation) {
			return;
		}
		void refresh(state, ctx, true);
	}, REFRESH_INTERVAL_MS);
}

function publish(
	state: RuntimeState,
	ctx: ExtensionContext,
	assessment: PaceAssessment,
): boolean {
	const status = ctx.ui.theme.fg(
		colorForVerdict(assessment.verdict),
		formatPaceStatus(assessment),
	);
	if (!safeSetStatus(ctx, status)) return false;
	if (assessment.verdict === "chill" && state.lastVerdict !== "chill") {
		ctx.ui.notify(formatChillWarning(assessment), "warning");
	}
	state.lastVerdict = assessment.verdict;
	return true;
}

function safeSetStatus(
	ctx: ExtensionContext,
	status: string | undefined,
): boolean {
	try {
		ctx.ui.setStatus(STATUS_ID, status);
		return true;
	} catch (error) {
		if (isStaleContextError(error)) return false;
		throw error;
	}
}

async function resolveHeaders(
	ctx: ExtensionContext,
): Promise<Record<string, string>> {
	const resolved = await ctx.modelRegistry.getProviderAuth(CODEX_PROVIDER);
	if (resolved?.auth.baseUrl && !isOfficialChatGptUrl(resolved.auth.baseUrl)) {
		throw new Error("Refusing to send proxy credentials to ChatGPT.");
	}
	const authorization =
		headerValue(resolved?.auth.headers, "Authorization") ??
		(resolved?.auth.apiKey ? `Bearer ${resolved.auth.apiKey}` : undefined);
	if (!authorization) throw new Error("Codex authentication is unavailable.");
	return { Authorization: authorization, "User-Agent": "pi-codex-pace" };
}

async function fetchJson(
	url: string,
	headers: Record<string, string>,
	signal: AbortSignal,
): Promise<unknown> {
	const response = await fetch(url, { headers, signal });
	if (!response.ok) {
		throw new Error(`Codex usage request returned HTTP ${response.status}.`);
	}
	const declaredLength = Number(response.headers.get("content-length"));
	if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
		throw new Error("Codex usage response was too large.");
	}
	const text = await response.text();
	if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) {
		throw new Error("Codex usage response was too large.");
	}
	try {
		return JSON.parse(text) as unknown;
	} catch {
		throw new Error("Codex usage response was not valid JSON.");
	}
}

function isOfficialCodexModel(model: Model | undefined): boolean {
	return (
		model?.provider === CODEX_PROVIDER && isOfficialChatGptUrl(model.baseUrl)
	);
}

function isOfficialChatGptUrl(value: string): boolean {
	try {
		return new URL(value).origin === "https://chatgpt.com";
	} catch {
		return false;
	}
}

function headerValue(
	headers: Record<string, string | null> | undefined,
	name: string,
): string | undefined {
	return (
		Object.entries(headers ?? {}).find(
			([key]) => key.toLowerCase() === name.toLowerCase(),
		)?.[1] ?? undefined
	);
}

function colorForVerdict(verdict: PaceVerdict): "dim" | "success" | "warning" {
	if (verdict === "chill") return "warning";
	if (verdict === "push") return "success";
	return "dim";
}

function formatChillWarning(assessment: PaceAssessment): string {
	const runway = assessment.runwayWorkdays?.toFixed(1) ?? "unknown";
	const scheduled = assessment.scheduledWorkdays?.toFixed(1) ?? "unknown";
	return `Codex pace: CHILL. ${Math.round(assessment.remainingPercent)}% remains, about ${runway} workdays at recent burn, with ${scheduled} scheduled before reset.`;
}

function isStaleContextError(error: unknown): boolean {
	return (
		error instanceof Error &&
		error.message.includes("ctx is stale after session replacement or reload")
	);
}
