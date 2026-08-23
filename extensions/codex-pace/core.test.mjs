import assert from "node:assert/strict";
import test from "node:test";
import {
	assessCodexPace,
	createTodayBaseline,
	formatPaceStatus,
	parseCodexQuota,
	parseDailyUsage,
} from "./core.ts";

process.env.TZ = "Europe/Madrid";

test("selects the longest Codex quota window", () => {
	const quota = parseCodexQuota({
		rate_limit: {
			primary_window: {
				used_percent: 12,
				limit_window_seconds: 18_000,
				reset_at: 1_800_000_000,
			},
			secondary_window: {
				used_percent: 4,
				limit_window_seconds: 604_800,
				reset_at: 1_800_604_800,
			},
		},
	});

	assert.deepEqual(quota, {
		usedPercent: 4,
		windowSeconds: 604_800,
		resetAtMs: 1_800_604_800_000,
	});
});

test("parses account-wide daily percentages", () => {
	const usage = parseDailyUsage({
		units: "percent",
		data: [
			{
				date: "2026-08-18",
				product_surface_usage_values: {
					cli: 12.5,
					desktop_app: 3.25,
					web: 0,
				},
			},
		],
	});

	assert.deepEqual(usage, [{ date: "2026-08-18", usedPercent: 15.75 }]);
	assert.throws(
		() => parseDailyUsage({ units: "tokens", data: [] }),
		/invalid daily usage/u,
	);
});

test("uses recent active weekdays and scheduled work hours", () => {
	const assessment = assessCodexPace({
		nowMs: Date.parse("2026-08-20T11:30:00Z"),
		quota: {
			usedPercent: 4,
			windowSeconds: 604_800,
			resetAtMs: Date.parse("2026-08-27T08:27:00Z"),
		},
		dailyUsage: [
			{ date: "2026-08-06", usedPercent: 13.323 },
			{ date: "2026-08-07", usedPercent: 20.132 },
			{ date: "2026-08-08", usedPercent: 0.782 },
			{ date: "2026-08-10", usedPercent: 12.957 },
			{ date: "2026-08-11", usedPercent: 24.133 },
			{ date: "2026-08-12", usedPercent: 100 },
			{ date: "2026-08-13", usedPercent: 18.336 },
			{ date: "2026-08-14", usedPercent: 23.375 },
			{ date: "2026-08-15", usedPercent: 48.786 },
			{ date: "2026-08-17", usedPercent: 0.3 },
			{ date: "2026-08-18", usedPercent: 0.426 },
			{ date: "2026-08-19", usedPercent: 0 },
			{ date: "2026-08-20", usedPercent: 0 },
		],
	});

	assert.equal(assessment.verdict, "steady");
	assert.equal(assessment.todayUsedPercent, 4);
	assert.equal(assessment.todayIsLowerBound, false);
	assert.equal(assessment.activeHistoryDays, 7);
	assert.ok(Math.abs(assessment.burnPercentPerWorkday - 20.132) < 0.001);
	assert.ok(Math.abs(assessment.runwayWorkdays - 4.77) < 0.01);
	assert.ok(Math.abs(assessment.scheduledWorkdays - 4.66) < 0.02);
	assert.equal(formatPaceStatus(assessment), "STEADY · today 4% · ~5d");
});

test("marks usage observed after the daily baseline as a lower bound", () => {
	const initial = {
		nowMs: Date.parse("2026-08-21T07:00:00Z"),
		quota: {
			usedPercent: 10,
			windowSeconds: 604_800,
			resetAtMs: Date.parse("2026-08-27T08:27:00Z"),
		},
		dailyUsage: [
			{ date: "2026-08-17", usedPercent: 20 },
			{ date: "2026-08-18", usedPercent: 20 },
			{ date: "2026-08-19", usedPercent: 20 },
			{ date: "2026-08-21", usedPercent: 0 },
		],
	};
	const assessment = assessCodexPace({
		...initial,
		nowMs: Date.parse("2026-08-21T11:00:00Z"),
		quota: { ...initial.quota, usedPercent: 14 },
		todayBaseline: createTodayBaseline(initial),
	});

	assert.equal(assessment.todayUsedPercent, 4);
	assert.equal(assessment.todayIsLowerBound, true);
	assert.match(formatPaceStatus(assessment), /today ≥4%/u);
});

test("uses clear push and chill thresholds", () => {
	const snapshot = {
		nowMs: Date.parse("2026-08-20T11:30:00Z"),
		quota: {
			usedPercent: 4,
			windowSeconds: 604_800,
			resetAtMs: Date.parse("2026-08-27T08:27:00Z"),
		},
		dailyUsage: [
			{ date: "2026-08-17", usedPercent: 5 },
			{ date: "2026-08-18", usedPercent: 5 },
			{ date: "2026-08-19", usedPercent: 5 },
		],
	};
	assert.equal(assessCodexPace(snapshot).verdict, "push");
	assert.equal(
		assessCodexPace({
			...snapshot,
			quota: { ...snapshot.quota, usedPercent: 50 },
			dailyUsage: snapshot.dailyUsage.map((day) => ({
				...day,
				usedPercent: 20,
			})),
		}).verdict,
		"chill",
	);
});
