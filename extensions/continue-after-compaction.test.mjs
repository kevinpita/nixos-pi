import assert from "node:assert/strict";
import test from "node:test";
import continueAfterCompaction, {
	CONTINUATION_PROMPT,
} from "./continue-after-compaction.ts";

function harness() {
	const handlers = new Map();
	const messages = [];
	const pi = {
		on(event, handler) {
			handlers.set(event, handler);
		},
		sendMessage(message, options) {
			messages.push({ message, options });
		},
	};

	continueAfterCompaction(pi);
	return { handlers, messages };
}

test("continues after compaction when Pi will not retry", () => {
	const state = harness();
	state.handlers.get("session_compact")({
		reason: "threshold",
		willRetry: false,
	});

	assert.deepEqual(state.messages, [
		{
			message: {
				customType: "continue-after-compaction",
				content: CONTINUATION_PROMPT,
				display: false,
			},
			options: {
				deliverAs: "followUp",
				triggerTurn: true,
			},
		},
	]);
});

test("does not duplicate overflow recovery", () => {
	const state = harness();
	state.handlers.get("session_compact")({
		reason: "overflow",
		willRetry: true,
	});

	assert.deepEqual(state.messages, []);
});
