export const MAX_RANGE_DAYS = 30;
export const DEFAULT_RANGE_DAYS = 7;
const DAY_MS = 86400000;

function invalid(message) {
  return Object.assign(new Error(message), { statusCode: 400 });
}

function calendarDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw invalid("日期格式应为 YYYY-MM-DD");
  }
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(0, 0, 0, 0);
  if (date.toISOString().slice(0, 10) !== value) throw invalid("日期无效");
  return date.getTime();
}

function formatter(timeZone, withTime = false) {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone, year: "numeric", month: "2-digit", day: "2-digit",
      ...(withTime ? { hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" } : {}),
    });
  } catch { throw invalid("时区无效"); }
}

function partsAt(date, fmt) {
  return Object.fromEntries(fmt.formatToParts(date).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
}

function dateAt(now, timeZone) {
  const parts = partsAt(now, formatter(timeZone));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function midnight(calendarMs, timeZone) {
  const fmt = formatter(timeZone, true);
  let value = calendarMs;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const parts = partsAt(value, fmt);
    const wall = new Date(0);
    wall.setUTCFullYear(Number(parts.year), Number(parts.month) - 1, Number(parts.day));
    wall.setUTCHours(Number(parts.hour), Number(parts.minute), Number(parts.second), 0);
    const delta = calendarMs - wall.getTime();
    if (!delta) return value;
    value += delta;
  }
  return value;
}

export function publicDateRange(range) {
  return { from: range.from, to: range.to, timeZone: range.timeZone };
}

export function normalizeDateRange(input, options = {}) {
  const timeZone = options.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (input?.from == null && input?.to == null) return recentDateRange(DEFAULT_RANGE_DAYS, { ...options, timeZone });
  if (input?.from == null || input?.to == null) throw invalid("请同时填写开始日期和结束日期");
  const fromMs = calendarDate(input.from);
  const toMs = calendarDate(input.to);
  const days = (toMs - fromMs) / DAY_MS + 1;
  if (days < 1) throw invalid("开始日期不能晚于结束日期");
  if (days > MAX_RANGE_DAYS) throw invalid(`时间范围不能超过 ${MAX_RANGE_DAYS} 个自然日`);
  return {
    from: input.from, to: input.to, timeZone,
    startMs: midnight(fromMs, timeZone), endExclusiveMs: midnight(toMs + DAY_MS, timeZone),
  };
}

export function recentDateRange(days = DEFAULT_RANGE_DAYS, options = {}) {
  if (!Number.isInteger(days) || days < 1 || days > MAX_RANGE_DAYS) throw invalid("时间范围应为 1–30 个自然日");
  const timeZone = options.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  const to = dateAt(options.now ?? Date.now(), timeZone);
  const from = new Date(calendarDate(to) - (days - 1) * DAY_MS).toISOString().slice(0, 10);
  return normalizeDateRange({ from, to }, { ...options, timeZone });
}

export function rangeKey(range) {
  return JSON.stringify([range.from, range.to, range.timeZone]);
}

export const normalizeRange = normalizeDateRange;
export const recentRange = recentDateRange;
