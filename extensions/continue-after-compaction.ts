type SessionCompactEvent = {
	readonly willRetry: boolean;
};

type ContinuationExtensionAPI = {
	on(
		event: "session_compact",
		handler: (event: SessionCompactEvent) => void,
	): void;
	sendMessage(
		message: {
			readonly customType: string;
			readonly content: string;
			readonly display: boolean;
		},
		options: {
			readonly deliverAs: "followUp";
			readonly triggerTurn: true;
		},
	): void;
};

export const CONTINUATION_PROMPT = `Compaction is complete. Review the current goal, progress, and next steps. Continue all unfinished work without waiting for another user message. Do not repeat work that is complete. If no work remains, give the normal completion report.`;

export default function (pi: ContinuationExtensionAPI) {
	pi.on("session_compact", (event) => {
		// Overflow recovery already retries the interrupted turn.
		if (event.willRetry) {
			return;
		}

		pi.sendMessage(
			{
				customType: "continue-after-compaction",
				content: CONTINUATION_PROMPT,
				display: false,
			},
			{
				deliverAs: "followUp",
				triggerTurn: true,
			},
		);
	});
}
