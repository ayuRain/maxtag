import type { RoutineSchedule } from './types.js';

interface LocalDateTime {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

function localParts(value: Date, timeZone: string): LocalDateTime {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  const values = Object.fromEntries(
    formatter
      .formatToParts(value)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, Number(part.value)]),
  );
  return {
    year: values.year,
    month: values.month,
    day: values.day,
    hour: values.hour,
    minute: values.minute,
  };
}

function localValue(parts: LocalDateTime): number {
  return Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
  );
}

function sameLocalDate(left: LocalDateTime, right: LocalDateTime): boolean {
  return (
    left.year === right.year &&
    left.month === right.month &&
    left.day === right.day
  );
}

function zonedDateTime(parts: LocalDateTime, timeZone: string): Date {
  const desired = localValue(parts);
  let timestamp = desired;
  for (let iteration = 0; iteration < 4; iteration += 1) {
    const observed = localParts(new Date(timestamp), timeZone);
    const difference = desired - localValue(observed);
    if (difference === 0) return new Date(timestamp);
    timestamp += difference;
  }

  const resolved = localParts(new Date(timestamp), timeZone);
  if (
    sameLocalDate(resolved, parts) &&
    resolved.hour * 60 + resolved.minute >= parts.hour * 60 + parts.minute
  ) {
    return new Date(timestamp);
  }

  // During a DST gap, run at the first valid local minute after the requested time.
  for (let minute = 1; minute <= 180; minute += 1) {
    const candidate = new Date(timestamp + minute * 60_000);
    const observed = localParts(candidate, timeZone);
    if (
      sameLocalDate(observed, parts) &&
      observed.hour * 60 + observed.minute >= parts.hour * 60 + parts.minute
    ) {
      return candidate;
    }
  }
  return new Date(timestamp);
}

function nextLocalDay(parts: LocalDateTime): LocalDateTime {
  const next = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + 1));
  return {
    year: next.getUTCFullYear(),
    month: next.getUTCMonth() + 1,
    day: next.getUTCDate(),
    hour: parts.hour,
    minute: parts.minute,
  };
}

export function normalizeRoutineSchedule(
  schedule: RoutineSchedule,
): RoutineSchedule {
  if (schedule.kind === 'once') {
    const at = new Date(schedule.at);
    if (!schedule.at || Number.isNaN(at.getTime())) {
      throw new Error('routine_once_at_must_be_iso_timestamp');
    }
    return { kind: 'once', at: at.toISOString() };
  }
  if (schedule.kind === 'interval') {
    const everyMinutes = Number(schedule.everyMinutes);
    if (
      !Number.isInteger(everyMinutes) ||
      everyMinutes < 1 ||
      everyMinutes > 43_200
    ) {
      throw new Error('routine_interval_minutes_must_be_between_1_and_43200');
    }
    return { kind: 'interval', everyMinutes };
  }

  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(schedule.time);
  if (!match) throw new Error('routine_daily_time_must_be_HH:mm');
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: schedule.timeZone }).format(
      new Date(),
    );
  } catch {
    throw new Error(`routine_invalid_time_zone:${schedule.timeZone}`);
  }
  return {
    kind: 'daily',
    time: `${match[1]}:${match[2]}`,
    timeZone: schedule.timeZone,
  };
}

export function nextRoutineRunAt(
  scheduleInput: RoutineSchedule,
  after: Date,
): Date {
  const schedule = normalizeRoutineSchedule(scheduleInput);
  if (schedule.kind === 'once') return new Date(schedule.at);
  if (schedule.kind === 'interval') {
    return new Date(after.getTime() + schedule.everyMinutes * 60_000);
  }

  const [hour, minute] = schedule.time.split(':').map(Number);
  const current = localParts(after, schedule.timeZone);
  let desired: LocalDateTime = {
    year: current.year,
    month: current.month,
    day: current.day,
    hour,
    minute,
  };
  let candidate = zonedDateTime(desired, schedule.timeZone);
  if (candidate.getTime() <= after.getTime()) {
    desired = nextLocalDay(desired);
    candidate = zonedDateTime(desired, schedule.timeZone);
  }
  return candidate;
}
