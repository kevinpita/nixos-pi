import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	getAgentDir,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

const STATE = "pi-fast";
const MODELS = new Set([
	"gpt-5.4",
	"gpt-5.5",
	"gpt-5.6",
	"gpt-5.6-luna",
	"gpt-5.6-sol",
	"gpt-5.6-terra",
	"gpt-6-astra",
]);

export default function piFast(pi: ExtensionAPI): void {
	let enabledByDefault = false;
	try {
		const config = JSON.parse(readFileSync(join(getAgentDir(), "pi-fast.json"), "utf8"));
		enabledByDefault = config.enabledByDefault === true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}

	// Capture at load time: foreground subagents can share the parent's process.
	const inherited = process.env.PI_FAST_STATE
		? JSON.parse(process.env.PI_FAST_STATE) as {
				sessionId: string;
				sessionFile?: string;
				enabled: boolean;
			}
		: undefined;
	let ownsEnvironment: boolean | undefined;
	let enabled = false;

	function supported(model: ExtensionContext["model"]): boolean {
		return model !== undefined
			&& (model.provider === "openai-codex" || model.provider === "openai")
			&& MODELS.has(model.id);
	}

	function update(ctx: ExtensionContext): void {
		// A child must not overwrite the value used to launch its siblings.
		if (ownsEnvironment) {
			process.env.PI_FAST_STATE = JSON.stringify({
				sessionId: ctx.sessionManager.getSessionId(),
				sessionFile: ctx.sessionManager.getSessionFile(),
				enabled,
			});
		}
		ctx.ui.setStatus(STATE, enabled
			? ctx.ui.theme.fg("accent", supported(ctx.model) ? "fast" : "fast (unsupported model)")
			: undefined);
	}

	function restore(ctx: ExtensionContext): void {
		const entry = ctx.sessionManager.getBranch().findLast(
			(entry) => entry.type === "custom" && entry.customType === STATE
				&& typeof entry.data === "boolean",
		);
		enabled = entry?.type === "custom"
			? entry.data as boolean
			: ownsEnvironment ? enabledByDefault : inherited!.enabled;
		// Save the initial default too, so resuming never depends on later config changes.
		if (!entry) pi.appendEntry(STATE, enabled);
		update(ctx);
	}

	pi.registerCommand("fast", {
		description: "Toggle fast service for this session and its subagents",
		handler: (_args, ctx) => {
			enabled = !enabled;
			pi.appendEntry(STATE, enabled);
			update(ctx);
			ctx.ui.notify(`Fast mode ${enabled ? "on" : "off"}.`, "info");
		},
	});

	pi.on("session_start", (event, ctx) => {
		ownsEnvironment ??= inherited === undefined
			|| inherited.sessionId === ctx.sessionManager.getSessionId()
			|| (event.reason !== "startup" && inherited.sessionFile === event.previousSessionFile);
		restore(ctx);
	});
	pi.on("session_tree", (_event, ctx) => restore(ctx));
	pi.on("model_select", (_event, ctx) => update(ctx));
	pi.on("before_provider_request", (event, ctx) => {
		if (!supported(ctx.model)) return;
		return { ...event.payload as object, service_tier: enabled ? "priority" : "default" };
	});
}
