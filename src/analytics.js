/**
 * Pulse analytics core — framework-free, dependency-free, pure functions.
 *
 * Events are plain objects:
 *   { id, name, ts, user, session, country, device, plan, page }
 *
 * Everything here is deterministic and unit-tested; the browser demo imports
 * this exact file, so what you see on screen is what the library computes.
 */

export const DAY = 86_400_000;
export const WEEK = 7 * DAY;

/** UTC day key, e.g. "2026-10-28". */
export function dayKey(ts) {
  return new Date(ts).toISOString().slice(0, 10);
}

/** Start of the UTC day containing `ts`. */
export function startOfDay(ts) {
  const d = new Date(ts);
  d.setUTCHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * Daily aggregates over the last `days` days ending at `end`.
 * Returns [{ date, events, users, sessions, signups }].
 */
export function dailySeries(events, { days = 30, end = Date.now() } = {}) {
  const endDay = startOfDay(end);
  const start = endDay - (days - 1) * DAY;
  const byDay = new Map();
  for (let i = 0; i < days; i++) {
    byDay.set(new Date(start + i * DAY).toISOString().slice(0, 10), {
      date: new Date(start + i * DAY).toISOString().slice(0, 10),
      events: 0, users: new Set(), sessions: new Set(), signups: 0,
    });
  }
  for (const e of events) {
    if (e.ts < start || e.ts > end) continue;
    const bucket = byDay.get(dayKey(e.ts));
    if (!bucket) continue;
    bucket.events++;
    bucket.users.add(e.user);
    bucket.sessions.add(e.session);
    if (e.name === "signup_complete") bucket.signups++;
  }
  return [...byDay.values()].map((b) => ({
    date: b.date, events: b.events, users: b.users.size, sessions: b.sessions.size, signups: b.signups,
  }));
}

/** Sum a numeric field over a series. */
export function total(series, key) {
  return series.reduce((acc, row) => acc + row[key], 0);
}

/** Mean of an array (0 for empty). */
export function mean(values) {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
}

/** Linear-interpolated percentile (p in 0..1). Mutates nothing. */
export function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const pos = (sorted.length - 1) * Math.min(1, Math.max(0, p));
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/** Trailing moving average; leading positions use the available prefix. */
export function movingAverage(values, window = 7) {
  return values.map((_, i) => {
    const from = Math.max(0, i - window + 1);
    return mean(values.slice(from, i + 1));
  });
}

/**
 * Ordered funnel with drop-off analysis.
 *
 * For each user we take the first occurrence of step 0, then require every
 * later step to happen strictly after it (and within `windowDays` of it).
 * Repeating a step never counts twice, and a user who did step 1 before step 0
 * is not converted.
 *
 * When `breakdown` is given (an event field such as "device"), each drop-off
 * transition also reports how the stalled users split across that field, using
 * the user's first event for the attribute value.
 *
 * @param {object[]} events
 * @param {string[]} steps  event names, 1..6 long
 * @param {{windowDays?: number, now?: number, breakdown?: string}} [options]
 * @returns {{steps: {step:string, users:number, fromPrev:number, fromStart:number}[],
 *            drops: {from:string, to:string, users:number, breakdown: Record<string, number>}[]}}
 */
export function funnelAnalysis(events, steps, { windowDays = 30, now = Infinity, breakdown = null } = {}) {
  const empty = { steps: steps.map((step, i) => ({ step, users: 0, fromPrev: i === 0 ? 1 : 0, fromStart: 0 })), drops: [] };
  if (!Array.isArray(steps) || steps.length < 1) return empty;

  const byUser = new Map();
  for (const e of events) {
    if (e.ts > now) continue;
    let list = byUser.get(e.user);
    if (!list) { list = []; byUser.set(e.user, list); }
    list.push(e);
  }
  const counts = new Array(steps.length).fill(0);
  const dropped = new Array(Math.max(0, steps.length - 1)).fill(0);
  const dropBreakdown = Array.from({ length: Math.max(0, steps.length - 1) }, () => ({}));
  const windowMs = windowDays * DAY;

  for (const list of byUser.values()) {
    list.sort((a, b) => a.ts - b.ts);
    const attr = breakdown ? list[0][breakdown] ?? "unknown" : null;
    let step = 0;
    let anchor = -1;
    for (const e of list) {
      if (e.name !== steps[step]) continue;
      if (step === 0) { anchor = e.ts; counts[0]++; step = 1; }
      else if (e.ts - anchor <= windowMs) { counts[step]++; step++; }
      if (step === steps.length) break;
    }
    if (step > 0 && step < steps.length) {
      dropped[step - 1]++;
      if (breakdown) dropBreakdown[step - 1][attr] = (dropBreakdown[step - 1][attr] || 0) + 1;
    }
  }

  return {
    steps: steps.map((step, i) => ({
      step,
      users: counts[i],
      fromPrev: i === 0 ? 1 : counts[i - 1] ? counts[i] / counts[i - 1] : 0,
      fromStart: counts[0] ? counts[i] / counts[0] : 0,
    })),
    drops: steps.slice(0, -1).map((from, i) => ({
      from, to: steps[i + 1], users: dropped[i], breakdown: dropBreakdown[i],
    })),
  };
}

/** Convenience wrapper returning only the step rows. */
export function funnel(events, steps, options = {}) {
  return funnelAnalysis(events, steps, options).steps;
}

/**
 * Weekly cohort retention.
 *
 * Cohort = week of the user's first event (0 = current week, `cohorts - 1` =
 * oldest). Cell [c][w] is the share of that cohort with at least one event in
 * week w of their lifetime. Cells beyond the observable window are null.
 *
 * @returns {{cohorts: {label: string, size: number, retention: (number|null)[]}[],
 *            curve: (number|null)[]}}
 */
export function retention(events, { cohorts = 8, weeks = 8, now = Date.now() } = {}) {
  const nowWeekStart = startOfDay(now) - ((new Date(now).getUTCDay() + 6) % 7) * DAY; // Monday
  const firstSeen = new Map();
  const activeWeeks = new Map(); // user -> Set(weekIndex)

  for (const e of events) {
    const prev = firstSeen.get(e.user);
    if (prev === undefined || e.ts < prev) firstSeen.set(e.user, e.ts);
  }
  for (const e of events) {
    const first = firstSeen.get(e.user);
    if (first === undefined || e.ts < first) continue;
    const cohortIdx = Math.floor((nowWeekStart - startOfWeek(first)) / WEEK);
    if (cohortIdx < 0 || cohortIdx >= cohorts) continue;
    const weekIdx = Math.floor((startOfWeek(e.ts) - startOfWeek(first)) / WEEK);
    if (weekIdx < 0 || weekIdx >= weeks) continue;
    if (!activeWeeks.has(e.user)) activeWeeks.set(e.user, new Set());
    activeWeeks.get(e.user).add(weekIdx);
  }

  const rows = [];
  for (let c = cohorts - 1; c >= 0; c--) {
    const members = [...firstSeen.entries()].filter(([, first]) => Math.floor((nowWeekStart - startOfWeek(first)) / WEEK) === c).map(([u]) => u);
    const size = members.length;
    const cells = [];
    for (let w = 0; w < weeks; w++) {
      // not observable yet: the week has not started for this cohort
      if (w > c) { cells.push(null); continue; }
      if (!size) { cells.push(null); continue; }
      const retained = members.filter((u) => activeWeeks.get(u)?.has(w)).length;
      cells.push(retained / size);
    }
    rows.push({
      label: cohortLabel(nowWeekStart - c * WEEK),
      size,
      retention: cells,
    });
  }
  const curve = [];
  for (let w = 0; w < weeks; w++) {
    const values = rows.map((r) => r.retention[w]).filter((v) => v !== null);
    curve.push(values.length ? mean(values) : null);
  }
  return { cohorts: rows, curve };
}

export function startOfWeek(ts) {
  const day = startOfDay(ts);
  const dow = (new Date(day).getUTCDay() + 6) % 7; // Monday = 0
  return day - dow * DAY;
}
function cohortLabel(weekStart) {
  const d = new Date(weekStart);
  return `${d.toLocaleString("en-US", { month: "short", timeZone: "UTC" })} ${d.getUTCDate()}`;
}

/** Count occurrences of a field across events, descending. */
export function topN(events, key, n = 5) {
  const counts = new Map();
  for (const e of events) {
    const v = typeof key === "function" ? key(e) : e[key];
    if (v === undefined || v === null) continue;
    counts.set(v, (counts.get(v) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([value, count]) => ({ value, count }));
}

/** Share of each value of `key`, as fractions that sum to 1. */
export function distribution(events, key) {
  const rows = topN(events, key, Infinity);
  const all = rows.reduce((a, r) => a + r.count, 0) || 1;
  return rows.map((r) => ({ value: r.value, count: r.count, share: r.count / all }));
}

/** Sessions per user, plus duration derived from first/last event. */
export function sessionStats(events) {
  const sessions = new Map();
  for (const e of events) {
    const s = sessions.get(e.session);
    if (!s) sessions.set(e.session, { id: e.session, user: e.user, start: e.ts, end: e.ts, events: 1 });
    else { s.start = Math.min(s.start, e.ts); s.end = Math.max(s.end, e.ts); s.events++; }
  }
  const list = [...sessions.values()];
  const durations = list.map((s) => s.end - s.start);
  return {
    sessions: list.length,
    perUser: list.length / new Set(list.map((s) => s.user)).size,
    medianDurationMs: percentile(durations, 0.5),
    p90DurationMs: percentile(durations, 0.9),
  };
}

/** Compare two adjacent periods of equal length and return relative deltas. */
export function periodDelta(events, { days = 30, end = Date.now() } = {}) {
  const current = events.filter((e) => e.ts > end - days * DAY && e.ts <= end);
  const previous = events.filter((e) => e.ts > end - 2 * days * DAY && e.ts <= end - days * DAY);
  const metric = (list, name) => (name === "users" ? new Set(list.map((e) => e.user)).size : list.length);
  return ["users", "events"].reduce((acc, name) => {
    const now = metric(current, name), before = metric(previous, name);
    acc[name] = { now, before, delta: before ? (now - before) / before : 0 };
    return acc;
  }, {});
}

/** Detect days whose event count deviates more than `z` from a trailing mean. */
export function detectAnomalies(series, z = 2) {
  const values = series.map((r) => r.events);
  const out = [];
  values.forEach((v, i) => {
    if (i < 7) return;
    const window = values.slice(i - 7, i);
    const mu = mean(window);
    const sd = Math.sqrt(mean(window.map((x) => (x - mu) ** 2)));
    if (sd > 0 && Math.abs(v - mu) / sd > z) out.push({ index: i, date: series[i].date, value: v, z: (v - mu) / sd });
  });
  return out;
}

/** Attach a human-readable label + tone to a delta fraction. */
export function describeDelta(delta) {
  return { pct: delta, tone: delta > 0.005 ? "up" : delta < -0.005 ? "down" : "flat" };
}
