import assert from "node:assert/strict";
import test from "node:test";
import codexPaceExtension from "./index.ts";

process.env.TZ = "Europe/Madrid";

const DAILY_PAYLOAD = {
	units: "percent",
	data: [
		{
			date: "2026-08-17",
			product_surface_usage_values: { cli: 20 },
		},
		{
			date: "2026-08-18",
			product_surface_usage_values: { desktop_app: 20 },
		},
		{
			date: "2026-08-19",
			product_surface_usage_values: { web: 20 },
		},
		{
			date: "2026-08-20",
			product_surface_usage_values: { cli: 0 },
		},
	],
};

test("publishes pace and warns once when the verdict changes to chill", async (t) => {
	const originalFetch = globalThis.fetch;
	const originalNow = Date.now;
	let usedPercent = 4;
	const requests = [];
	globalThis.fetch = async (url, options) => {
		requests.push({ url: String(url), headers: options?.headers });
		const payload = String(url).endsWith("daily-token-usage-breakdown")
			? DAILY_PAYLOAD
			: {
					rate_limit: {
						primary_window: {
							used_percent: usedPercent,
							limit_window_seconds: 604_800,
							reset_at: Date.parse("2026-08-27T08:27:00Z") / 1_000,
						},
					},
				};
		return new Response(JSON.stringify(payload), { status: 200 });
	};
	Date.now = () => Date.parse("2026-08-20T11:30:00Z");
	t.after(() => {
		globalThis.fetch = originalFetch;
		Date.now = originalNow;
	});

	const handlers = new Map();
	const statuses = [];
	const notifications = [];
	const pi = {
		on(event, handler) {
			handlers.set(event, handler);
		},
	};
	const ctx = {
		hasUI: true,
		model: {
			provider: "openai-codex",
			baseUrl: "https://chatgpt.com/backend-api/codex",
		},
		modelRegistry: {
			async getProviderAuth() {
				return { auth: { apiKey: "test-token" } };
			},
		},
		ui: {
			theme: { fg: (_color, text) => text },
			setStatus: (_id, status) => statuses.push(status),
			notify: (message, level) => notifications.push({ message, level }),
		},
	};
	codexPaceExtension(pi);

	// Handlers fire refreshes without blocking, so flush the event loop before
	// asserting on their effects.
	const settle = async () => {
		for (let i = 0; i < 20; i++) {
			await new Promise((resolve) => setImmediate(resolve));
		}
	};

	handlers.get("session_start")({}, ctx);
	await settle();
	assert.equal(statuses.at(-1), "STEADY · today 4% · ~5d");
	assert.equal(notifications.length, 0);

	usedPercent = 50;
	handlers.get("model_select")({}, ctx);
	await settle();
	handlers.get("model_select")({}, ctx);
	await settle();
	assert.equal(statuses.at(-1), "CHILL · today 50% · ~3d");
	assert.equal(notifications.length, 1);
	assert.equal(notifications[0].level, "warning");
	assert.match(notifications[0].message, /Codex pace: CHILL/u);
	assert.equal(requests.length, 6);
	assert.ok(
		requests.every(
			(request) =>
				request.url.startsWith("https://chatgpt.com/backend-api/wham/") &&
				request.headers.Authorization === "Bearer test-token",
		),
	);

	ctx.model.baseUrl = "https://proxy.example.test/v1";
	handlers.get("model_select")({}, ctx);
	await settle();
	assert.equal(requests.length, 6);
	assert.equal(statuses.at(-1), undefined);

	handlers.get("session_shutdown")({}, ctx);
	assert.equal(statuses.at(-1), undefined);
});
