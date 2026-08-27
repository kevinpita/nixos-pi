/**
 * auto-compact
 *
 * Pi checks its compaction threshold only after an agent run ends. A long
 * tool-calling run can grow far past the context window before that check
 * runs, because the Codex backend accepts requests above the declared window.
 *
 * This extension does two things:
 *
 * 1. Mid-run guard. After each turn it reads the context usage. When usage
 *    crosses COMPACT_THRESHOLD_PERCENT and the run still has tool calls to
 *    continue from, it stops the run, compacts, and resumes the work in a
 *    fresh run.
 *
 * 2. Resume after Pi's own auto-compaction. Pi compacts after a run ends or
 *    right before a new user prompt. The extension sends a resume message
 *    only when that is safe and useful:
 *    - inside the run loop (Pi queues it as a follow-up and continues), and
 *    - the run did not end with a clean final answer.
 *
 *    It never starts a nested run from inside a compaction. That nested run
 *    left Pi in the "compacting" state, so Escape could not stop it and
 *    typed messages failed with "Use steer() or followUp()".
 */

type StopReason = "stop" | "toolUse" | "length" | "error" | "aborted";

type ContentPart = { readonly type: string };

type TurnMessage = {
	readonly role: string;
	readonly stopReason?: StopReason;
	readonly content?: string | readonly ContentPart[];
};

type TurnEndEvent = {
	readonly turnIndex: number;
	readonly message: TurnMessage;
};

type CompactionReason = "manual" | "threshold" | "overflow";

type SessionCompactEvent = {
	readonly reason: CompactionReason;
	readonly willRetry: boolean;
};

type ContextUsage =
	| {
			readonly tokens: number | null;
			readonly contextWindow: number;
			readonly percent: number | null;
	  }
	| undefined;

type CompactOptions = {
	readonly customInstructions?: string;
	readonly onComplete?: (result: unknown) => void;
	readonly onError?: (error: Error) => void;
};

export type ExtensionContext = {
	readonly hasUI: boolean;
	readonly ui: {
		notify(message: string, level: "info" | "warning" | "error"): void;
	};
	isIdle(): boolean;
	getContextUsage(): ContextUsage;
	compact(options: CompactOptions): void;
};

type CustomMessage = {
	readonly customType: string;
	readonly content: string;
	readonly display: boolean;
};

type SendMessageOptions = {
	readonly deliverAs: "followUp";
	readonly triggerTurn: true;
};

export type ExtensionAPI = {
	on(
		event: "turn_end",
		handler: (event: TurnEndEvent, ctx: ExtensionContext) => void,
	): void;
	on(
		event: "session_compact",
		handler: (event: SessionCompactEvent, ctx: ExtensionContext) => void,
	): void;
	sendMessage(message: CustomMessage, options: SendMessageOptions): void;
};

export type Schedule = (callback: () => void, delayMs: number) => void;

export type Options = {
	readonly thresholdPercent?: number;
	readonly schedule?: Schedule;
};

/** Context usage (percent of the model window) that triggers the mid-run guard. */
export const COMPACT_THRESHOLD_PERCENT = 90;

/**
 * Delay before the resume message after a guard compaction. The TUI flushes
 * messages typed during compaction right after compaction ends. The delay lets
 * such a message start its run first; the resume is then skipped.
 */
export const RESUME_DELAY_MS = 250;

export const RESUME_MESSAGE_TYPE = "auto-compact-resume";

export const RESUME_PROMPT = `Compaction is complete. Review the goal, progress, and next steps in the summary. Continue the unfinished work now. Do not wait for another user message. Do not repeat work that is complete. If no work remains, give the normal completion report.`;

function hasToolCalls(message: TurnMessage): boolean {
	if (!Array.isArray(message.content)) return false;
	return message.content.some((part) => part.type === "toolCall");
}

/**
 * True when the guard must compact now: the context crossed the threshold and
 * the run is about to make another model call to react to tool results.
 */
export function turnNeedsCompaction(
	message: TurnMessage,
	usage: ContextUsage,
	thresholdPercent: number,
): boolean {
	if (message.role !== "assistant") return false;
	if (message.stopReason !== "toolUse" && message.stopReason !== "stop") {
		return false;
	}
	if (!hasToolCalls(message)) return false;
	if (!usage || usage.percent === null) return false;
	return usage.percent >= thresholdPercent;
}

/** True when the run ended before the model gave a clean final answer. */
export function turnWasInterrupted(message: TurnMessage): boolean {
	if (message.role !== "assistant") return false;
	return message.stopReason !== "stop" || hasToolCalls(message);
}

/**
 * Decide whether to queue a resume message from the session_compact event.
 *
 * - willRetry: Pi retries the interrupted turn itself.
 * - manual: `/compact` by the user, or the guard (which resumes on its own).
 * - idle: compaction ran before a user prompt; that prompt follows anyway, and
 *   a resume here would start a nested run inside the compaction.
 */
export function shouldResumeAfterCompaction(
	event: SessionCompactEvent,
	idle: boolean,
	lastTurn: TurnMessage | undefined,
): boolean {
	if (event.willRetry) return false;
	if (event.reason === "manual") return false;
	if (idle) return false;
	return lastTurn !== undefined && turnWasInterrupted(lastTurn);
}

function notify(
	ctx: ExtensionContext,
	message: string,
	level: "info" | "warning" | "error",
): void {
	if (ctx.hasUI) ctx.ui.notify(message, level);
}

export default function (pi: ExtensionAPI, options: Options = {}): void {
	const thresholdPercent = options.thresholdPercent ?? COMPACT_THRESHOLD_PERCENT;
	const schedule: Schedule = options.schedule ?? ((cb, ms) => setTimeout(cb, ms));

	let lastTurn: TurnMessage | undefined;
	let guardInFlight = false;
	// Set after a failed guard compaction. Prevents an abort loop when
	// compaction keeps failing. Cleared by the next successful compaction.
	let guardDisabled = false;

	function sendResume(): void {
		pi.sendMessage(
			{
				customType: RESUME_MESSAGE_TYPE,
				content: RESUME_PROMPT,
				display: true,
			},
			{ deliverAs: "followUp", triggerTurn: true },
		);
	}

	function scheduleResume(ctx: ExtensionContext): void {
		schedule(() => {
			// A message typed during compaction already started a run.
			if (!ctx.isIdle()) return;
			sendResume();
		}, RESUME_DELAY_MS);
	}

	pi.on("turn_end", (event, ctx) => {
		const message = event.message;
		if (message.role !== "assistant") return;
		lastTurn = message;

		if (guardInFlight || guardDisabled) return;
		const usage = ctx.getContextUsage();
		if (!turnNeedsCompaction(message, usage, thresholdPercent)) return;

		guardInFlight = true;
		const percent = Math.round(usage?.percent ?? 0);
		notify(ctx, `Context at ${percent}%. Compacting before the next step.`, "info");

		ctx.compact({
			onComplete: () => {
				guardInFlight = false;
				scheduleResume(ctx);
			},
			onError: (error) => {
				guardInFlight = false;
				guardDisabled = true;
				notify(
					ctx,
					`Mid-run compaction failed: ${error.message}. Mid-run compaction is off until the next compaction.`,
					"error",
				);
				// The run was stopped for the compaction. Resume it anyway.
				scheduleResume(ctx);
			},
		});
	});

	pi.on("session_compact", (event, ctx) => {
		guardDisabled = false;
		if (!shouldResumeAfterCompaction(event, ctx.isIdle(), lastTurn)) return;
		// Inside the run loop Pi queues this as a follow-up and continues.
		sendResume();
	});
}
