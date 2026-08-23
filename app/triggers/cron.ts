// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
/**
 * Cron parsing, written rather than depended on.
 *
 * A five-field cron parser is ~150 lines and this is them. The alternative is a
 * dependency, and the argument against it here is not "not invented here" — it is
 * that this code decides *when money is spent without a human present*. An hourly
 * automation that a library's edge case turns into a per-minute automation is
 * sixty sandboxes an hour, billed, until somebody notices. That is a small enough
 * surface to own outright and a large enough consequence to want to.
 *
 * Supported: `m h dom mon dow`, with `*`, `n`, `a-b`, `a-b/s`, `*\/s` and comma
 * lists. Plus the four shorthands people actually type.
 *
 * Deliberately NOT supported, because each is a way to be surprised:
 *   - seconds (a six-field expression is silently reinterpreted by some parsers,
 *     turning "every hour" into "every minute" — we reject it instead);
 *   - `L`, `W`, `#` (last, weekday, nth) — rarely wanted, easy to get wrong;
 *   - `@reboot`, which has no meaning for a stateless scheduler.
 */

export class CronError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CronError";
	}
}

const SHORTHANDS: Record<string, string> = {
	"@hourly": "0 * * * *",
	"@daily": "0 0 * * *",
	"@weekly": "0 0 * * 0",
	"@monthly": "0 0 1 * *",
};

const FIELDS = [
	{ name: "minute", min: 0, max: 59 },
	{ name: "hour", min: 0, max: 23 },
	{ name: "day of month", min: 1, max: 31 },
	{ name: "month", min: 1, max: 12 },
	{ name: "day of week", min: 0, max: 6 },
] as const;

const MONTH_NAMES = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DAY_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

function parseField(spec: string, index: number): Set<number> {
	const field = FIELDS[index]!;
	const values = new Set<number>();

	for (const part of spec.split(",")) {
		const [rangePart, stepPart] = part.split("/");
		const step = stepPart === undefined ? 1 : Number(stepPart);
		if (!Number.isInteger(step) || step < 1) {
			throw new CronError(`"${part}" has an invalid step in the ${field.name} field.`);
		}

		let from: number;
		let to: number;

		if (rangePart === "*" || rangePart === "?") {
			from = field.min;
			to = field.max;
		} else if (rangePart!.includes("-")) {
			const [a, b] = rangePart!.split("-");
			from = named(a!, index, field);
			to = named(b!, index, field);
		} else {
			from = named(rangePart!, index, field);
			to = from;
		}

		if (from > to) {
			throw new CronError(
				`"${part}" runs backwards in the ${field.name} field. Wrapping ranges are not `
					+ "supported; write two comma-separated ranges instead.",
			);
		}

		for (let value = from; value <= to; value += step) values.add(value);
	}

	return values;
}

function named(token: string, index: number, field: (typeof FIELDS)[number]): number {
	const lower = token.toLowerCase();
	if (index === 3) {
		const month = MONTH_NAMES.indexOf(lower);
		if (month >= 0) return month + 1;
	}
	if (index === 4) {
		const day = DAY_NAMES.indexOf(lower);
		if (day >= 0) return day;
		// Both 0 and 7 mean Sunday in every cron anyone has used. Rejecting 7
		// because the table says 0-6 would be technically defensible and would break
		// expressions people copy from their existing crontab.
		if (token === "7") return 0;
	}

	const value = Number(token);
	if (!Number.isInteger(value) || value < field.min || value > field.max) {
		throw new CronError(
			`"${token}" is not valid in the ${field.name} field (expected ${field.min}-${field.max}).`,
		);
	}
	return value;
}

export interface CronSchedule {
	minute: Set<number>;
	hour: Set<number>;
	dayOfMonth: Set<number>;
	month: Set<number>;
	dayOfWeek: Set<number>;
	/** True when both day fields are restricted — see the note in `matches`. */
	bothDaysRestricted: boolean;
}

export function parseCron(expression: string): CronSchedule {
	const normalised = (SHORTHANDS[expression.trim().toLowerCase()] ?? expression).trim();
	const parts = normalised.split(/\s+/);

	if (parts.length === 6) {
		throw new CronError(
			"Six-field cron expressions (with seconds) are not supported. Some parsers accept "
				+ "them and some silently reinterpret them, which turns 'every hour' into 'every "
				+ "minute' — sixty sandboxes an hour, billed, until somebody notices. Use five fields.",
		);
	}
	if (parts.length !== 5) {
		throw new CronError(
			`Expected five fields (minute hour day-of-month month day-of-week), got ${parts.length}.`,
		);
	}

	const [minute, hour, dayOfMonth, month, dayOfWeek] = parts.map((part, index) =>
		parseField(part, index),
	) as [Set<number>, Set<number>, Set<number>, Set<number>, Set<number>];

	return {
		minute,
		hour,
		dayOfMonth,
		month,
		dayOfWeek,
		bothDaysRestricted: parts[2] !== "*" && parts[4] !== "*",
	};
}

/**
 * Does this schedule fire at this minute, in this timezone?
 *
 * The day-field rule is cron's one genuine oddity and it is not a bug: when
 * *both* day-of-month and day-of-week are restricted, they are OR-ed rather than
 * AND-ed. `0 0 1 * mon` means "the 1st, and also every Monday", not "Mondays that
 * fall on the 1st". Every cron implementation does this, so matching it is what
 * makes a copied crontab line behave as its author expects.
 */
export function matches(schedule: CronSchedule, when: Date, timezone: string): boolean {
	const parts = zonedParts(when, timezone);

	if (!schedule.minute.has(parts.minute)) return false;
	if (!schedule.hour.has(parts.hour)) return false;
	if (!schedule.month.has(parts.month)) return false;

	const dom = schedule.dayOfMonth.has(parts.dayOfMonth);
	const dow = schedule.dayOfWeek.has(parts.dayOfWeek);
	return schedule.bothDaysRestricted ? dom || dow : dom && dow;
}

/**
 * Calendar fields in an arbitrary IANA timezone, without a dependency.
 *
 * `Intl.DateTimeFormat` is the only thing in the platform that knows when Berlin
 * changed its offset in 1980, and it ships with Node. Doing the arithmetic by
 * hand would mean shipping a timezone database or getting daylight saving wrong —
 * and getting it wrong means an automation configured for 09:00 firing at 08:00
 * for half the year, in a system whose whole job is to do things while nobody is
 * watching.
 */
/**
 * Formatters are cached per timezone, and that is not a micro-optimisation.
 *
 * Constructing an `Intl.DateTimeFormat` loads and configures timezone data, and
 * it is roughly three orders of magnitude more expensive than using one. The
 * forward scan in `nextRun` calls this up to two million times for a schedule
 * that never fires, so constructing one per call turned a bounded scan into a
 * hang — which is exactly the failure the bound was supposed to prevent, moved
 * one level down.
 */
const FORMATTERS = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timezone: string): Intl.DateTimeFormat {
	let formatter = FORMATTERS.get(timezone);
	if (!formatter) {
		formatter = new Intl.DateTimeFormat("en-GB", {
			timeZone: timezone,
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
			hour: "2-digit",
			minute: "2-digit",
			weekday: "short",
			hour12: false,
		});
		FORMATTERS.set(timezone, formatter);
	}
	return formatter;
}

function zonedParts(date: Date, timezone: string) {
	const formatter = formatterFor(timezone);

	const parts: Record<string, string> = {};
	for (const part of formatter.formatToParts(date)) parts[part.type] = part.value;

	return {
		minute: Number(parts.minute),
		// `Intl` renders midnight as "24" in en-GB with hour12:false, which is
		// correct ISO and wrong for a cron field where midnight is hour 0. Left
		// unhandled this makes every `0 0 * * *` automation never fire, which is the
		// most common expression there is.
		hour: Number(parts.hour) % 24,
		dayOfMonth: Number(parts.day),
		month: Number(parts.month),
		dayOfWeek: DAY_NAMES.indexOf((parts.weekday ?? "").slice(0, 3).toLowerCase()),
	};
}

/**
 * The next minute at or after `from` at which this schedule fires.
 *
 * Scans forward minute by minute, bounded. A closed-form solution would be faster
 * and is not worth the bugs: this runs once per automation per fire, not in a
 * loop, and the bound means a schedule that can never fire (`0 0 30 2 *` — the
 * 30th of February) returns null in four years of scanning rather than hanging.
 */
export function nextRun(
	expression: string,
	from: Date,
	timezone = "UTC",
): Date | null {
	const schedule = parseCron(expression);

	// The impossible-date check, before any scanning.
	//
	// `0 0 30 2 *` — the 30th of February — is valid syntax that can never fire,
	// and somebody will type it. Discovering that by scanning four years of
	// minutes is two million iterations to reach a conclusion available from four
	// integers. Doing it up front means the bounded scan below only ever runs for
	// schedules that can actually match.
	if (!schedule.bothDaysRestricted && !canMonthDayEverOccur(schedule)) return null;

	// Start at the next whole minute so an automation cannot re-fire within the
	// minute it just ran.
	const cursor = new Date(from.getTime());
	cursor.setUTCSeconds(0, 0);
	cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);

	// Four years, so a `29 2 *` schedule finds its leap year. Every reachable
	// schedule matches within a small fraction of this; the bound exists so a
	// combination we failed to anticipate terminates rather than hangs.
	const limitMinutes = 366 * 4 * 24 * 60;
	for (let step = 0; step < limitMinutes; step += 1) {
		if (matches(schedule, cursor, timezone)) return new Date(cursor.getTime());
		cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);
	}
	return null;
}

/** 29 for February, so a leap-year-only schedule is not wrongly rejected. */
const LONGEST_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function canMonthDayEverOccur(schedule: CronSchedule): boolean {
	for (const month of schedule.month) {
		const longest = LONGEST_MONTH[month - 1]!;
		for (const day of schedule.dayOfMonth) {
			if (day <= longest) return true;
		}
	}
	return false;
}

/** Validate without computing a time. Used by the settings form. */
export function describeCron(expression: string, timezone = "UTC"): string {
	const next = nextRun(expression, new Date(), timezone);
	if (!next) {
		throw new CronError(
			`"${expression}" is valid but never fires — check the day and month fields.`,
		);
	}
	return `next run ${next.toISOString()}`;
}
