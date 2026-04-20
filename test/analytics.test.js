import test from "node:test";
import assert from "node:assert/strict";
import {
  DAY, WEEK, dayKey, startOfDay, startOfWeek, dailySeries, total, mean, percentile,
  movingAverage, funnel, retention, topN, distribution, sessionStats, periodDelta,
  detectAnomalies, describeDelta, funnelAnalysis,
} from "../src/analytics.js";

const NOW = Date.UTC(2026, 9, 28, 12, 0, 0); // 2026-10-28T12:00:00Z
const ev = (user, name, ts, extra = {}) => ({
  id: `${user}-${name}-${ts}`, user, name, ts,
  session: `${user}-s`, country: "NP", device: "desktop", plan: "free", page: "/", ...extra,
});

test("dayKey and startOfDay are UTC based", () => {
  assert.equal(dayKey(Date.UTC(2026, 9, 28, 23, 59)), "2026-10-28");
  assert.equal(startOfDay(Date.UTC(2026, 9, 28, 23, 59)), Date.UTC(2026, 9, 28));
  assert.equal(startOfDay(Date.UTC(2026, 9, 29, 0, 1)), Date.UTC(2026, 9, 29));
});

test("startOfWeek returns Monday 00:00 UTC", () => {
  // 2026-10-28 is a Wednesday
  const monday = startOfWeek(Date.UTC(2026, 9, 28, 15));
  assert.equal(new Date(monday).getUTCDay(), 1);
  assert.equal(new Date(monday).toISOString(), "2026-10-26T00:00:00.000Z");
});

test("dailySeries buckets events, unique users and sessions", () => {
  const events = [
    ev("u1", "page_view", NOW - 2 * DAY, { session: "a" }),
    ev("u2", "page_view", NOW - 2 * DAY, { session: "b" }),
    ev("u1", "page_view", NOW - 2 * DAY, { session: "a" }),
    ev("u3", "signup_complete", NOW - 1 * DAY, { session: "c" }),
    ev("u4", "page_view", NOW - 100 * DAY), // outside range
  ];
  const series = dailySeries(events, { days: 3, end: NOW });
  assert.equal(series.length, 3);
  const [day1, day2, day3] = series;
  assert.equal(day1.events, 3);
  assert.equal(day1.users, 2);
  assert.equal(day1.sessions, 2); // both sessions on same day
  assert.equal(day2.signups, 1);
  assert.equal(total(series, "events"), 4);
});

test("funnel requires ordered steps and never double counts", () => {
  const events = [
    // u1 converts all three
    ev("u1", "visit", 100), ev("u1", "signup", 200), ev("u1", "activate", 300),
    // u2 does signup before visit -> not converted, but counts at step 0 start
    ev("u2", "signup", 100), ev("u2", "visit", 200), ev("u2", "activate", 300),
    // u3 repeats visit then converts
    ev("u3", "visit", 100), ev("u3", "visit", 150), ev("u3", "signup", 200), ev("u3", "activate", 250),
    // u4 visits only
    ev("u4", "visit", 100),
  ];
  const result = funnel(events, ["visit", "signup", "activate"]);
  assert.deepEqual(result.map((r) => r.users), [4, 2, 2]);
  assert.equal(result[1].fromPrev, 0.5);
  assert.equal(result[2].fromStart, 0.5);
  assert.deepEqual(result.map((r) => r.step), ["visit", "signup", "activate"]);
});

test("funnel respects the conversion window", () => {
  const events = [
    ev("fast", "visit", 0), ev("fast", "buy", DAY),
    ev("slow", "visit", 0), ev("slow", "buy", 40 * DAY),
  ];
  assert.deepEqual(funnel(events, ["visit", "buy"], { windowDays: 7 }).map((r) => r.users), [2, 1]);
  assert.deepEqual(funnel(events, ["visit", "buy"], { windowDays: 60 }).map((r) => r.users), [2, 2]);
});

test("funnel ignores events after `now`", () => {
  const events = [ev("u", "visit", 0), ev("u", "buy", NOW + DAY)];
  assert.deepEqual(funnel(events, ["visit", "buy"], { now: NOW }).map((r) => r.users), [1, 0]);
});

test("retention computes cohort sizes and week buckets", () => {
  const events = [];
  // cohort in the current week (started 2026-10-26)
  events.push(ev("a", "page_view", Date.UTC(2026, 9, 27)));
  events.push(ev("a", "page_view", Date.UTC(2026, 9, 28)));
  events.push(ev("b", "page_view", Date.UTC(2026, 9, 26)));
  // cohort one week older
  events.push(ev("c", "page_view", Date.UTC(2026, 9, 20)));
  events.push(ev("c", "page_view", Date.UTC(2026, 9, 27))); // came back in week 1
  events.push(ev("d", "page_view", Date.UTC(2026, 9, 21)));

  const { cohorts, curve } = retention(events, { cohorts: 2, weeks: 3, now: NOW });
  // ordered oldest -> newest
  assert.equal(cohorts.length, 2);
  assert.equal(cohorts[0].size, 2, "older cohort has c and d");
  assert.equal(cohorts[1].size, 2, "current cohort has a and b");
  // older cohort: week 0 = 100%, week 1 = 50% (came back), week 2 unobservable
  assert.equal(cohorts[0].retention[0], 1);
  assert.equal(cohorts[0].retention[1], 0.5);
  assert.equal(cohorts[0].retention[2], null);
  // current cohort: week 0 = 100%, later weeks null
  assert.equal(cohorts[1].retention[0], 1);
  assert.equal(cohorts[1].retention[1], null);
  assert.equal(curve[0], 1);
  assert.equal(curve[1], 0.5);
});

test("percentile interpolates between neighbours", () => {
  assert.equal(percentile([], 0.5), 0);
  assert.equal(percentile([10], 0.9), 10);
  assert.equal(percentile([1, 2, 3, 4], 0.5), 2.5);
  assert.equal(percentile([1, 2, 3, 4], 0), 1);
  assert.equal(percentile([1, 2, 3, 4], 1), 4);
  assert.equal(percentile([1, 2, 3, 4], 0.25), 1.75);
});

test("movingAverage uses a trailing window without shrinking the output", () => {
  assert.deepEqual(movingAverage([1, 2, 3, 4, 5], 2), [1, 1.5, 2.5, 3.5, 4.5]);
  assert.deepEqual(movingAverage([10, 10, 10], 7), [10, 10, 10]);
  assert.deepEqual(movingAverage([], 3), []);
});

test("topN and distribution rank by frequency", () => {
  const events = [
    ev("u1", "page_view", 1, { page: "/pricing" }),
    ev("u2", "page_view", 1, { page: "/pricing" }),
    ev("u3", "page_view", 1, { page: "/" }),
    ev("u4", "signup_start", 1, { page: null }),
  ];
  assert.deepEqual(topN(events, "page", 2), [{ value: "/pricing", count: 2 }, { value: "/", count: 1 }]);
  const dist = distribution(events, "page");
  assert.equal(dist.length, 2);
  assert.equal(dist[0].share, 2 / 3);
});

test("sessionStats derives unique sessions, per-user ratio and durations", () => {
  const events = [
    ev("u1", "page_view", 0, { session: "s1" }),
    ev("u1", "page_view", 1000, { session: "s1" }),
    ev("u2", "page_view", 500, { session: "s2" }),
  ];
  const stats = sessionStats(events);
  assert.equal(stats.sessions, 2);
  assert.equal(stats.perUser, 1);
  assert.equal(stats.medianDurationMs, 500);
});

test("periodDelta compares equal adjacent windows", () => {
  const events = [
    ev("u1", "page_view", NOW - 1 * DAY),
    ev("u2", "page_view", NOW - 2 * DAY),
    ev("u1", "page_view", NOW - 10 * DAY),
  ];
  const d = periodDelta(events, { days: 7, end: NOW });
  assert.equal(d.users.now, 2);
  assert.equal(d.users.before, 1);
  assert.equal(d.users.delta, 1);
});

test("detectAnomalies flags a spike after a stable week", () => {
  const series = Array.from({ length: 12 }, (_, i) => ({ date: `d${i}`, events: i === 10 ? 10_000 : 100 + (i % 3) }));
  const found = detectAnomalies(series, 2);
  assert.equal(found.length, 1);
  assert.equal(found[0].index, 10);
  assert.ok(found[0].z > 2);
});

test("describeDelta classifies direction", () => {
  assert.equal(describeDelta(0.1).tone, "up");
  assert.equal(describeDelta(-0.1).tone, "down");
  assert.equal(describeDelta(0.001).tone, "flat");
});

test("funnelAnalysis reports drop-off users and their device split", () => {
  const events = [
    ev("u1", "visit", 0, { device: "mobile" }), ev("u1", "buy", 10),
    ev("u2", "visit", 0, { device: "desktop" }),
    ev("u3", "visit", 0, { device: "mobile" }),
  ];
  const analysis = funnelAnalysis(events, ["visit", "buy"], { breakdown: "device" });
  assert.deepEqual(analysis.steps.map((s) => s.users), [3, 1]);
  assert.equal(analysis.drops.length, 1);
  assert.equal(analysis.drops[0].users, 2);
  assert.deepEqual(analysis.drops[0].breakdown, { desktop: 1, mobile: 1 });
  assert.deepEqual(analysis.drops[0].from, "visit");
  assert.deepEqual(analysis.drops[0].to, "buy");
});
