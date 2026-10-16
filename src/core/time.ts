// Small natural-language time parser ("fri 6pm", "in 2h", "tomorrow 9am") with IANA timezone support.

export const DEFAULT_TZ = "Asia/Kolkata";

export function isValidTz(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

interface Wall {
  y: number;
  m: number;
  d: number;
  hh: number;
  mm: number;
  dow: number; // 0 = Sunday
}

const DOW = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

function wallClock(ts: number, tz: string): Wall {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    weekday: "short",
  }).formatToParts(new Date(ts));
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  return {
    y: Number(get("year")),
    m: Number(get("month")),
    d: Number(get("day")),
    hh: Number(get("hour")),
    mm: Number(get("minute")),
    dow: DOW.indexOf(get("weekday").slice(0, 3).toLowerCase()),
  };
}

/** Offset (ms) of `tz` from UTC at instant `ts`: local wall time minus UTC. */
function tzOffset(ts: number, tz: string): number {
  const w = wallClock(ts, tz);
  const floored = Math.floor(ts / 60_000) * 60_000;
  return Date.UTC(w.y, w.m - 1, w.d, w.hh, w.mm) - floored;
}

function zonedToUtc(y: number, m: number, d: number, hh: number, mm: number, tz: string): number {
  const asUtc = Date.UTC(y, m - 1, d, hh, mm);
  let t = asUtc - tzOffset(asUtc, tz);
  t = asUtc - tzOffset(t, tz);
  return t;
}

const UNIT_MS: Record<string, number> = {
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
};

const DAY_RE =
  /\b(today|tonight|tomorrow|tmrw|tom|sun(?:day)?|mon(?:day)?|tue(?:s|sday)?|wed(?:nesday)?|thu(?:r|rs|rsday)?|fri(?:day)?|sat(?:urday)?)\b/;

/** Parse a deadline into epoch ms, or null if it can't be understood or is not in the future. */
export function parseWhen(input: string, now: number, tz: string = DEFAULT_TZ): number | null {
  const s = input.trim().toLowerCase().replace(/\s+/g, " ");
  if (!s) return null;

  const rel = s.match(/^in (\d+(?:\.\d+)?) ?(m|min|mins|minutes?|h|hr|hrs|hours?|d|days?|w|weeks?)$/);
  if (rel) {
    const t = now + Number(rel[1]) * UNIT_MS[rel[2][0]];
    return t > now ? Math.round(t) : null;
  }

  const dayMatch = s.match(DAY_RE);
  const dayWord = dayMatch?.[1];
  const timeStr = s
    .replace(DAY_RE, " ")
    .replace(/\b(next|at|on|by|this)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  let hh: number | null = null;
  let mm = 0;
  if (timeStr === "noon") hh = 12;
  else if (timeStr === "midnight") hh = 0;
  else if (timeStr !== "") {
    const t = timeStr.match(/^(\d{1,2})(?::(\d{2}))? ?(am|pm)?$/);
    if (!t) return null;
    let h = Number(t[1]);
    mm = t[2] ? Number(t[2]) : 0;
    if (mm > 59) return null;
    if (t[3]) {
      if (h < 1 || h > 12) return null;
      h = (h % 12) + (t[3] === "pm" ? 12 : 0);
    } else if (!t[2]) {
      return null; // bare "6" is ambiguous
    } else if (h > 23) return null;
    hh = h;
  }
  if (!dayWord && hh === null) return null;

  const nowW = wallClock(now, tz);
  const build = (dayOffset: number, h: number, min: number): number => {
    const base = new Date(Date.UTC(nowW.y, nowW.m - 1, nowW.d + dayOffset));
    return zonedToUtc(base.getUTCFullYear(), base.getUTCMonth() + 1, base.getUTCDate(), h, min, tz);
  };

  let result: number;
  if (!dayWord) {
    result = build(0, hh!, mm);
    if (result <= now) result = build(1, hh!, mm);
  } else if (dayWord === "today" || dayWord === "tonight") {
    result = build(0, hh ?? (dayWord === "tonight" ? 20 : 9), mm);
  } else if (dayWord === "tomorrow" || dayWord === "tmrw" || dayWord === "tom") {
    result = build(1, hh ?? 9, mm);
  } else {
    const target = DOW.indexOf(dayWord.slice(0, 3));
    let ahead = (target - nowW.dow + 7) % 7;
    result = build(ahead, hh ?? 9, mm);
    if (result <= now) result = build(ahead + 7, hh ?? 9, mm);
  }
  return result > now ? result : null;
}

export function formatWhen(ts: number, tz: string = DEFAULT_TZ): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(ts));
}
