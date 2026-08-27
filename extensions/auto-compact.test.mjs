import assert from "node:assert/strict";
import test from "node:test";
import autoCompact, {
	COMPACT_THRESHOLD_PERCENT,
	RESUME_DELAY_MS,
	RESUME_MESSAGE_TYPE,
	RESUME_PROMPT,
	shouldResumeAfterCompaction,
	turnNeedsCompaction,
	turnWasInterrupted,
} from "./auto-compact.ts";

const toolTurn = {
	role: "assistant",
	stopReason: "toolUse",
	content: [{ type: "text", text: "Reading" }, { type: "toolCall", id: "1", name: "read" }],
};
const finalTurn = { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Done" }] };
const errorTurn = { role: "assistant", stopReason: "error", content: [{ type: "text", text: "" }] };
const abortedTurn = { role: "assistant", stopReason: "aborted", content: [{ type: "text", text: "" }] };

const usage = (percent) => ({ tokens: Math.round(2720 * percent), contextWindow: 272000, percent });

const expectedResume = {
	message: { customType: RESUME_MESSAGE_TYPE, content: RESUME_PROMPT, display: true },
	options: { deliverAs: "followUp", triggerTurn: true },
};

function harness({ idle = true, percent = 10, thresholdPercent } = {}) {
	const handlers = new Map();
	const messages = [];
	const compactions = [];
	const notifications = [];
	const scheduled = [];
	const state = { idle, percent };
	const pi = {
		on(event, handler) {
			handlers.set(event, handler);
		},
		sendMessage(message, options) {
			messages.push({ message, options });
		},
	};
	const ctx = {
		hasUI: true,
		ui: {
			notify(message, level) {
				notifications.push({ message, level });
			},
		},
		isIdle: () => state.idle,
		getContextUsage: () => usage(state.percent),
		compact(options) {
			compactions.push(options);
		},
	};
	autoCompact(pi, {
		thresholdPercent,
		schedule(callback, delayMs) {
			scheduled.push({ callback, delayMs });
		},
	});
	return {
		state,
		messages,
		compactions,
		notifications,
		scheduled,
		turnEnd: (message) => handlers.get("turn_end")({ turnIndex: 0, message }, ctx),
		sessionCompact: (event) => handlers.get("session_compact")(event, ctx),
		runScheduled() {
			const pending = scheduled.splice(0);
			for (const entry of pending) entry.callback();
			return pending;
		},
	};
}

test("turnNeedsCompaction only fires for a continuing run above the threshold", () => {
	assert.equal(turnNeedsCompaction(toolTurn, usage(95), 90), true);
	assert.equal(turnNeedsCompaction(toolTurn, usage(90), 90), true);
	assert.equal(turnNeedsCompaction(toolTurn, usage(89), 90), false);
	assert.equal(turnNeedsCompaction(finalTurn, usage(95), 90), false);
	assert.equal(turnNeedsCompaction(errorTurn, usage(95), 90), false);
	assert.equal(turnNeedsCompaction(abortedTurn, usage(95), 90), false);
	assert.equal(turnNeedsCompaction({ role: "user", content: "hi" }, usage(95), 90), false);
	assert.equal(turnNeedsCompaction(toolTurn, undefined, 90), false);
	assert.equal(
		turnNeedsCompaction(toolTurn, { tokens: null, contextWindow: 272000, percent: null }, 90),
		false,
	);
});

test("turnWasInterrupted is false only for a clean final answer", () => {
	assert.equal(turnWasInterrupted(finalTurn), false);
	assert.equal(turnWasInterrupted(toolTurn), true);
	assert.equal(turnWasInterrupted(errorTurn), true);
	assert.equal(turnWasInterrupted(abortedTurn), true);
	assert.equal(turnWasInterrupted({ role: "assistant", stopReason: "length", content: [] }), true);
});

test("shouldResumeAfterCompaction", () => {
	const threshold = { reason: "threshold", willRetry: false };
	assert.equal(shouldResumeAfterCompaction(threshold, false, errorTurn), true);
	assert.equal(shouldResumeAfterCompaction(threshold, false, toolTurn), true);
	assert.equal(shouldResumeAfterCompaction(threshold, false, finalTurn), false);
	assert.equal(shouldResumeAfterCompaction(threshold, false, undefined), false);
	assert.equal(shouldResumeAfterCompaction(threshold, true, errorTurn), false);
	assert.equal(shouldResumeAfterCompaction({ reason: "manual", willRetry: false }, false, errorTurn), false);
	assert.equal(shouldResumeAfterCompaction({ reason: "overflow", willRetry: true }, false, errorTurn), false);
	assert.equal(shouldResumeAfterCompaction({ reason: "overflow", willRetry: false }, false, errorTurn), true);
});

test("guard compacts mid-run above the threshold and resumes when idle", () => {
	const h = harness({ percent: 92 });
	h.turnEnd(toolTurn);

	assert.equal(h.compactions.length, 1);
	assert.deepEqual(h.notifications, [
		{ message: "Context at 92%. Compacting before the next step.", level: "info" },
	]);

	// Pi does not resume on our own (manual) compaction.
	h.sessionCompact({ reason: "manual", willRetry: false });
	assert.deepEqual(h.messages, []);

	h.compactions[0].onComplete({});
	assert.equal(h.scheduled.length, 1);
	assert.equal(h.scheduled[0].delayMs, RESUME_DELAY_MS);
	h.runScheduled();
	assert.deepEqual(h.messages, [expectedResume]);
});

test("guard skips the resume when a queued user message already started a run", () => {
	const h = harness({ percent: 95 });
	h.turnEnd(toolTurn);
	h.compactions[0].onComplete({});
	h.state.idle = false;
	h.runScheduled();
	assert.deepEqual(h.messages, []);
});

test("guard does not fire below the threshold, on a final answer, or twice at once", () => {
	const h = harness({ percent: 50 });
	h.turnEnd(toolTurn);
	assert.equal(h.compactions.length, 0);

	h.state.percent = 99;
	h.turnEnd(finalTurn);
	assert.equal(h.compactions.length, 0);

	h.turnEnd(toolTurn);
	h.turnEnd(toolTurn);
	assert.equal(h.compactions.length, 1);
});

test("guard uses the default threshold", () => {
	const h = harness({ percent: COMPACT_THRESHOLD_PERCENT - 1 });
	h.turnEnd(toolTurn);
	assert.equal(h.compactions.length, 0);
	h.state.percent = COMPACT_THRESHOLD_PERCENT;
	h.turnEnd(toolTurn);
	assert.equal(h.compactions.length, 1);
});

test("failed guard compaction still resumes and disables the guard until the next compaction", () => {
	const h = harness({ percent: 95 });
	h.turnEnd(toolTurn);
	h.compactions[0].onError(new Error("Nothing to compact"));
	assert.equal(h.notifications.at(-1).level, "error");
	assert.match(h.notifications.at(-1).message, /Nothing to compact/);

	h.runScheduled();
	assert.deepEqual(h.messages, [expectedResume]);

	h.turnEnd(toolTurn);
	assert.equal(h.compactions.length, 1);

	h.state.idle = false;
	h.sessionCompact({ reason: "threshold", willRetry: false });
	h.turnEnd(toolTurn);
	assert.equal(h.compactions.length, 2);
});

test("resumes after Pi's post-run compaction when the run was interrupted", () => {
	const h = harness({ idle: false });
	h.turnEnd(errorTurn);
	h.sessionCompact({ reason: "threshold", willRetry: false });
	assert.deepEqual(h.messages, [expectedResume]);
});

test("does not resume after Pi's post-run compaction when the run finished cleanly", () => {
	const h = harness({ idle: false });
	h.turnEnd(finalTurn);
	h.sessionCompact({ reason: "threshold", willRetry: false });
	assert.deepEqual(h.messages, []);
});

test("does not resume when Pi retries the turn itself", () => {
	const h = harness({ idle: false });
	h.turnEnd(errorTurn);
	h.sessionCompact({ reason: "overflow", willRetry: true });
	assert.deepEqual(h.messages, []);
});

test("does not resume from a compaction that runs before a user prompt", () => {
	const h = harness({ idle: true });
	h.turnEnd(errorTurn);
	h.sessionCompact({ reason: "threshold", willRetry: false });
	assert.deepEqual(h.messages, []);
});

test("does not resume after a manual /compact", () => {
	const h = harness({ idle: true });
	h.turnEnd(toolTurn);
	h.sessionCompact({ reason: "manual", willRetry: false });
	assert.deepEqual(h.messages, []);
});

test("notify is skipped without a UI", () => {
	const handlers = new Map();
	const pi = { on: (e, f) => handlers.set(e, f), sendMessage() {} };
	autoCompact(pi, { schedule() {} });
	const ctx = {
		hasUI: false,
		ui: {
			notify() {
				throw new Error("must not notify");
			},
		},
		isIdle: () => true,
		getContextUsage: () => usage(99),
		compact() {},
	};
	handlers.get("turn_end")({ turnIndex: 0, message: toolTurn }, ctx);
});
