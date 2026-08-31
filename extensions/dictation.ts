/// <reference path="./dictation-runtime.d.ts" />

import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";

const STATUS_ID = "dictation";
const START_TIMEOUT_MS = 10_000;
const STATUS_TIMEOUT_MS = 2_000;
const CANCEL_TIMEOUT_MS = 10_000;
const TRANSCRIPTION_TIMEOUT_MS = 10 * 60_000;
const TRANSCRIBED_STATUS_MS = 4_000;

const STATUS_BOLD = "\u001b[1m";
const STATUS_RED = "\u001b[38;2;255;85;85m";
const STATUS_BLUE = "\u001b[38;2;80;170;255m";
const STATUS_GREEN = "\u001b[38;2;0;255;135m";
const STATUS_RESET = "\u001b[39m\u001b[22m";

type Phase = "idle" | "starting" | "recording" | "transcribing";

type BackendStatus = {
	recording: boolean;
	busy?: boolean;
	startedAtMs?: number;
};

type DictationState = {
	ownerId: string;
	phase: Phase;
	startedAtMs?: number;
	statusTimer?: ReturnType<typeof setInterval>;
	activeOperation?: AbortController;
	togglePending: boolean;
	closed: boolean;
};

function vividStatus(color: string, text: string): string {
	return `${STATUS_BOLD}${color}${text}${STATUS_RESET}`;
}

function formatElapsed(startedAtMs: number): string {
	const elapsedSeconds = Math.max(
		0,
		Math.floor((Date.now() - startedAtMs) / 1_000),
	);
	const minutes = Math.floor(elapsedSeconds / 60);
	const seconds = elapsedSeconds % 60;
	return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function clearStatusTimer(state: DictationState): void {
	if (state.statusTimer) clearInterval(state.statusTimer);
	state.statusTimer = undefined;
}

function showIdle(state: DictationState, ctx: ExtensionContext): void {
	clearStatusTimer(state);
	state.phase = "idle";
	state.startedAtMs = undefined;
	ctx.ui.setStatus(STATUS_ID, undefined);
}

function showRecording(
	state: DictationState,
	ctx: ExtensionContext,
	startedAtMs = Date.now(),
): void {
	clearStatusTimer(state);
	state.phase = "recording";
	state.startedAtMs = startedAtMs;

	const updateStatus = (): void => {
		if (state.closed || state.phase !== "recording" || !state.startedAtMs) {
			return;
		}
		const label = `● REC ${formatElapsed(state.startedAtMs)}`;
		ctx.ui.setStatus(STATUS_ID, vividStatus(STATUS_RED, label));
	};

	updateStatus();
	state.statusTimer = setInterval(updateStatus, 1_000);
}

function showStarting(state: DictationState, ctx: ExtensionContext): void {
	clearStatusTimer(state);
	state.phase = "starting";
	ctx.ui.setStatus(
		STATUS_ID,
		vividStatus(STATUS_BLUE, "● Starting microphone..."),
	);
}

function showTranscribing(state: DictationState, ctx: ExtensionContext): void {
	clearStatusTimer(state);
	state.phase = "transcribing";
	state.startedAtMs = undefined;
	ctx.ui.setStatus(STATUS_ID, vividStatus(STATUS_BLUE, "◌ Transcribing..."));
}

function showTranscribed(state: DictationState, ctx: ExtensionContext): void {
	clearStatusTimer(state);
	state.phase = "idle";
	state.startedAtMs = undefined;
	ctx.ui.setStatus(STATUS_ID, vividStatus(STATUS_GREEN, "✓ TRANSCRIBED"));
	state.statusTimer = setTimeout(() => {
		if (state.closed || state.phase !== "idle") return;
		state.statusTimer = undefined;
		ctx.ui.setStatus(STATUS_ID, undefined);
	}, TRANSCRIBED_STATUS_MS);
}

function commandError(
	result: { stderr: string; code: number },
	fallback: string,
): string {
	const lines = result.stderr
		.trim()
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean);
	return lines.at(-1)?.replace(/^dictate-toggle:\s*/, "") || fallback;
}

async function readBackendStatus(pi: ExtensionAPI): Promise<BackendStatus> {
	let result;
	try {
		result = await pi.exec("dictate-toggle", ["status", "--quiet"], {
			timeout: STATUS_TIMEOUT_MS,
		});
	} catch {
		return { recording: false };
	}
	if (result.killed || result.code !== 0) return { recording: false };

	const status = result.stdout.trim();
	if (status === "transcribing" || status === "busy") {
		return { recording: false, busy: true };
	}

	const match = status.match(/^recording(?:\s+(\d+))?$/);
	if (!match) return { recording: false };

	const startedAtSeconds = Number(match[1]);
	return {
		recording: true,
		startedAtMs:
			Number.isSafeInteger(startedAtSeconds) && startedAtSeconds > 0
				? startedAtSeconds * 1_000
				: Date.now(),
	};
}

async function startRecording(
	pi: ExtensionAPI,
	state: DictationState,
	ctx: ExtensionContext,
): Promise<void> {
	showStarting(state, ctx);
	const operation = new AbortController();
	state.activeOperation = operation;
	let result;
	try {
		result = await pi.exec(
			"dictate-toggle",
			["start", "--quiet", "--owner", state.ownerId],
			{
				signal: operation.signal,
				timeout: START_TIMEOUT_MS,
			},
		);
	} catch (error: unknown) {
		if (state.closed) return;
		showIdle(state, ctx);
		ctx.ui.notify(
			`Dictation could not start: ${error instanceof Error ? error.message : "unknown error"}`,
			"error",
		);
		return;
	} finally {
		if (state.activeOperation === operation) {
			state.activeOperation = undefined;
		}
	}
	if (state.closed) return;

	if (result.killed || result.code !== 0) {
		showIdle(state, ctx);
		ctx.ui.notify(
			`Dictation could not start: ${commandError(result, "unknown error")}`,
			"error",
		);
		return;
	}

	showRecording(state, ctx);
}

async function stopAndTranscribe(
	pi: ExtensionAPI,
	state: DictationState,
	ctx: ExtensionContext,
): Promise<void> {
	showTranscribing(state, ctx);
	const operation = new AbortController();
	state.activeOperation = operation;
	let result;
	try {
		result = await pi.exec("dictate-toggle", ["stop", "--stdout", "--quiet"], {
			signal: operation.signal,
			timeout: TRANSCRIPTION_TIMEOUT_MS,
		});
	} catch (error: unknown) {
		if (state.closed) return;
		showIdle(state, ctx);
		ctx.ui.notify(
			`Dictation failed: ${error instanceof Error ? error.message : "transcription failed"}`,
			"error",
		);
		return;
	} finally {
		if (state.activeOperation === operation) {
			state.activeOperation = undefined;
		}
	}
	if (state.closed) return;

	if (result.killed || result.code !== 0) {
		showIdle(state, ctx);
		ctx.ui.notify(
			`Dictation failed: ${commandError(result, "transcription failed")}`,
			"error",
		);
		return;
	}

	const transcript = result.stdout.trim();
	if (!transcript) {
		showIdle(state, ctx);
		ctx.ui.notify("Dictation produced no text", "warning");
		return;
	}

	ctx.ui.pasteToEditor(transcript);
	showTranscribed(state, ctx);
	ctx.ui.notify("Dictation inserted. Press Enter to send.", "info");
}

async function toggleDictation(
	pi: ExtensionAPI,
	state: DictationState,
	ctx: ExtensionContext,
): Promise<void> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify(
			"Dictation is available only in Pi's interactive TUI",
			"warning",
		);
		return;
	}

	if (state.togglePending) {
		ctx.ui.notify("A dictation operation is already running", "warning");
		return;
	}

	state.togglePending = true;
	try {
		if (state.phase === "starting" || state.phase === "transcribing") {
			ctx.ui.notify(
				state.phase === "starting"
					? "The microphone is still starting"
					: "Transcription is already running",
				"warning",
			);
			return;
		}

		if (state.phase === "recording") {
			await stopAndTranscribe(pi, state, ctx);
			return;
		}

		const backend = await readBackendStatus(pi);
		if (state.closed) return;
		if (backend.busy) {
			ctx.ui.notify("Another dictation is still transcribing", "warning");
			return;
		}
		if (backend.recording) {
			showRecording(state, ctx, backend.startedAtMs);
			await stopAndTranscribe(pi, state, ctx);
			return;
		}

		await startRecording(pi, state, ctx);
	} finally {
		state.togglePending = false;
	}
}

async function cancelBackendRecording(
	pi: ExtensionAPI,
	ownerId: string,
	attemptsRemaining = 5,
): Promise<void> {
	let result;
	try {
		result = await pi.exec(
			"dictate-toggle",
			["cancel", "--quiet", "--owner", ownerId],
			{
				timeout: CANCEL_TIMEOUT_MS,
			},
		);
	} catch {
		return;
	}

	if (!result.killed && result.code === 0) return;
	if (
		attemptsRemaining <= 1 ||
		!result.stderr.includes("Another dictation operation")
	) {
		return;
	}

	await new Promise((resolve) => setTimeout(resolve, 100));
	await cancelBackendRecording(pi, ownerId, attemptsRemaining - 1);
}

export default function (pi: ExtensionAPI): void {
	const state: DictationState = {
		ownerId: `pi-${process.pid}`,
		phase: "idle",
		togglePending: false,
		closed: false,
	};

	pi.on("session_start", (_event, ctx) => {
		state.closed = false;
		if (ctx.mode !== "tui") return;

		// Only detects the rare recording-already-in-flight case, so don't
		// block session start on the status subprocess.
		void readBackendStatus(pi).then((backend) => {
			if (state.closed) return;
			if (backend.recording) {
				showRecording(state, ctx, backend.startedAtMs);
			}
		});
	});

	pi.on("session_shutdown", async (event, ctx) => {
		state.closed = true;
		if (event.reason === "quit") {
			state.activeOperation?.abort();
		}
		state.activeOperation = undefined;
		clearStatusTimer(state);
		ctx.ui.setStatus(STATUS_ID, undefined);

		if (event.reason === "quit") {
			await cancelBackendRecording(pi, state.ownerId);
		}
	});

	pi.registerShortcut("ctrl+space", {
		description: "Toggle local Whisper dictation",
		handler: async (ctx) => toggleDictation(pi, state, ctx),
	});

	pi.registerCommand("dictate", {
		description: "Toggle local Whisper dictation",
		handler: async (_args, ctx) => toggleDictation(pi, state, ctx),
	});
}
