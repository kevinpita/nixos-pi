export type PaceVerdict = "learning" | "push" | "steady" | "chill";

export type CodexQuotaWindow = {
	readonly usedPercent: number;
	readonly windowSeconds: number;
	readonly resetAtMs: number;
};

export type DailyUsage = {
	readonly date: string;
	readonly usedPercent: number;
};

type WorkSchedule = {
	readonly weekdays: readonly number[];
	readonly startHour: number;
	readonly endHour: number;
};

export type TodayBaseline = {
	readonly date: string;
	readonly resetAtMs: number;
	readonly quotaUsedPercent: number;
	readonly remoteUsedPercent: number;
};

export type PaceSnapshot = {
	readonly nowMs: number;
	readonly quota: CodexQuotaWindow;
	readonly dailyUsage: readonly DailyUsage[];
	readonly todayBaseline?: TodayBaseline;
};

export type PaceAssessment = {
	readonly verdict: PaceVerdict;
	readonly remainingPercent: number;
	readonly todayUsedPercent: number;
	readonly todayIsLowerBound: boolean;
	readonly activeHistoryDays: number;
	readonly burnPercentPerWorkday?: number;
	readonly runwayWorkdays?: number;
	readonly scheduledWorkdays?: number;
};

const DEFAULT_WORK_SCHEDULE: WorkSchedule = {
	weekdays: [1, 2, 3, 4, 5],
	startHour: 9,
	endHour: 18,
};

const ACTIVE_DAY_MIN_PERCENT = 1;
const MAX_HISTORY_DAYS = 15;
const MIN_HISTORY_DAYS = 3;
const HEADROOM_PERCENT = 5;
const CHILL_RATIO = 0.8;
const PUSH_RATIO = 1.25;

export function parseCodexQuota(payload: unknown): CodexQuotaWindow {
	const rateLimit = asObject(asObject(payload)?.rate_limit);
	const windows = [rateLimit?.primary_window, rateLimit?.secondary_window]
		.map(asObject)
		.flatMap((window) => {
			const usedPercent = asFiniteNumber(window?.used_percent);
			const windowSeconds = asFiniteNumber(window?.limit_window_seconds);
			const resetAt = asFiniteNumber(window?.reset_at);
			if (
				usedPercent === undefined ||
				windowSeconds === undefined ||
				windowSeconds <= 0 ||
				resetAt === undefined
			) {
				return [];
			}
			return [
				{
					usedPercent: clampPercent(usedPercent),
					windowSeconds,
					resetAtMs: resetAt * 1_000,
				},
			];
		});
	const quota = windows.sort((a, b) => b.windowSeconds - a.windowSeconds)[0];
	if (!quota) throw new Error("Codex returned no valid quota window.");
	return quota;
}

export function parseDailyUsage(payload: unknown): DailyUsage[] {
	const value = asObject(payload);
	if (value?.units !== "percent" || !Array.isArray(value.data)) {
		throw new Error("Codex returned invalid daily usage data.");
	}
	const byDate = new Map<string, DailyUsage>();
	for (const item of value.data) {
		const row = asObject(item);
		const date = row?.date;
		const surfaces = asObject(row?.product_surface_usage_values);
		if (typeof date !== "string" || !isDateKey(date) || !surfaces) {
			continue;
		}
		const usedPercent = Object.values(surfaces).reduce<number>(
			(total, surface) => {
				const number = asFiniteNumber(surface);
				return number !== undefined && number >= 0 ? total + number : total;
			},
			0,
		);
		byDate.set(date, { date, usedPercent: clampPercent(usedPercent) });
	}
	return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

export function createTodayBaseline(snapshot: PaceSnapshot): TodayBaseline {
	const date = localDateKey(snapshot.nowMs);
	return {
		date,
		resetAtMs: snapshot.quota.resetAtMs,
		quotaUsedPercent: snapshot.quota.usedPercent,
		remoteUsedPercent: usageForDate(snapshot.dailyUsage, date),
	};
}

export function assessCodexPace(snapshot: PaceSnapshot): PaceAssessment {
	const schedule = DEFAULT_WORK_SCHEDULE;
	const date = localDateKey(snapshot.nowMs);
	const remainingPercent = 100 - clampPercent(snapshot.quota.usedPercent);
	const remoteToday = usageForDate(snapshot.dailyUsage, date);
	const windowStartMs =
		snapshot.quota.resetAtMs - snapshot.quota.windowSeconds * 1_000;
	const windowStartedToday = localDateKey(windowStartMs) === date;
	let todayUsedPercent = remoteToday;
	let todayIsLowerBound = true;
	if (windowStartedToday) {
		todayUsedPercent = snapshot.quota.usedPercent;
		todayIsLowerBound = false;
	} else if (
		snapshot.todayBaseline?.date === date &&
		snapshot.todayBaseline.resetAtMs === snapshot.quota.resetAtMs
	) {
		const observedDelta = Math.max(
			0,
			snapshot.quota.usedPercent - snapshot.todayBaseline.quotaUsedPercent,
		);
		todayUsedPercent = Math.max(
			remoteToday,
			snapshot.todayBaseline.remoteUsedPercent + observedDelta,
		);
	}

	const activeHistory = snapshot.dailyUsage
		.filter(
			(day) =>
				day.date < date &&
				schedule.weekdays.includes(dayOfWeek(day.date)) &&
				day.usedPercent >= ACTIVE_DAY_MIN_PERCENT,
		)
		.sort((a, b) => a.date.localeCompare(b.date))
		.slice(-MAX_HISTORY_DAYS);
	const base = {
		remainingPercent,
		todayUsedPercent: clampPercent(todayUsedPercent),
		todayIsLowerBound,
		activeHistoryDays: activeHistory.length,
	};
	if (activeHistory.length < MIN_HISTORY_DAYS) {
		return { verdict: "learning", ...base };
	}

	const burnPercentPerWorkday = median(
		activeHistory.map((day) => day.usedPercent),
	);
	const runwayWorkdays = remainingPercent / burnPercentPerWorkday;
	const scheduledWorkdays = workdayEquivalentsBetween(
		snapshot.nowMs,
		snapshot.quota.resetAtMs,
		schedule,
	);
	const safeRunway =
		Math.max(0, remainingPercent - HEADROOM_PERCENT) / burnPercentPerWorkday;
	const ratio =
		scheduledWorkdays > 0 ? safeRunway / scheduledWorkdays : Infinity;
	let verdict: PaceVerdict = "steady";
	if (ratio < CHILL_RATIO) verdict = "chill";
	if (ratio > PUSH_RATIO) verdict = "push";
	return {
		verdict,
		...base,
		burnPercentPerWorkday,
		runwayWorkdays,
		scheduledWorkdays,
	};
}

export function formatPaceStatus(assessment: PaceAssessment): string {
	let today = "today pending";
	if (!assessment.todayIsLowerBound || assessment.todayUsedPercent >= 0.5) {
		const qualifier = assessment.todayIsLowerBound ? "≥" : "";
		today = `today ${qualifier}${Math.round(assessment.todayUsedPercent)}%`;
	}
	const parts = [assessment.verdict.toUpperCase(), today];
	if (assessment.runwayWorkdays !== undefined) {
		parts.push(`~${Math.round(assessment.runwayWorkdays)}d`);
	}
	return parts.join(" · ");
}

function usageForDate(usage: readonly DailyUsage[], date: string): number {
	return usage.find((day) => day.date === date)?.usedPercent ?? 0;
}

function localDateKey(timestampMs: number): string {
	const date = new Date(timestampMs);
	return [
		date.getFullYear().toString().padStart(4, "0"),
		(date.getMonth() + 1).toString().padStart(2, "0"),
		date.getDate().toString().padStart(2, "0"),
	].join("-");
}

function dayOfWeek(date: string): number {
	return new Date(`${date}T12:00:00Z`).getUTCDay();
}

function median(values: readonly number[]): number {
	const sorted = [...values].sort((a, b) => a - b);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 0
		? (sorted[middle - 1] + sorted[middle]) / 2
		: sorted[middle];
}

function workdayEquivalentsBetween(
	startMs: number,
	endMs: number,
	schedule: WorkSchedule,
): number {
	if (endMs <= startMs) return 0;
	const workdayMs = (schedule.endHour - schedule.startHour) * 60 * 60 * 1_000;
	let totalMs = 0;
	let cursor = new Date(startMs);
	cursor.setHours(0, 0, 0, 0);
	while (cursor.getTime() < endMs) {
		if (schedule.weekdays.includes(cursor.getDay())) {
			const workStart = new Date(cursor);
			workStart.setHours(schedule.startHour, 0, 0, 0);
			const workEnd = new Date(cursor);
			workEnd.setHours(schedule.endHour, 0, 0, 0);
			const overlapStart = Math.max(startMs, workStart.getTime());
			const overlapEnd = Math.min(endMs, workEnd.getTime());
			totalMs += Math.max(0, overlapEnd - overlapStart);
		}
		cursor = new Date(
			cursor.getFullYear(),
			cursor.getMonth(),
			cursor.getDate() + 1,
		);
	}
	return totalMs / workdayMs;
}

function asObject(value: unknown): Record<string, unknown> | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return undefined;
	}
	return value as Record<string, unknown>;
}

function asFiniteNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function clampPercent(value: number): number {
	return Math.max(0, Math.min(100, value));
}

function isDateKey(value: string): boolean {
	if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
	const date = new Date(`${value}T00:00:00Z`);
	return Number.isFinite(date.getTime()) && date.toISOString().startsWith(value);
}
