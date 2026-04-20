/**
 * Deterministic demo dataset for Pulse.
 *
 * Generates a realistic product-analytics event stream: 4,000 anonymous users,
 * 90 days of activity, growth-skewed signups, decaying return visits and an
 * activation funnel. Same seed => byte-identical events, which keeps the demo,
 * the screenshots and the tests in sync.
 *
 * No PII is generated: users are ids, countries are coarse, properties are
 * enumerated values.
 */

export const DAY = 86_400_000;

export const COUNTRIES = [
  ["United States", 0.26], ["India", 0.16], ["United Kingdom", 0.11], ["Germany", 0.09],
  ["Nepal", 0.12], ["Canada", 0.06], ["Australia", 0.06], ["Singapore", 0.05],
  ["Brazil", 0.05], ["Netherlands", 0.04],
];
export const DEVICES = [["desktop", 0.55], ["mobile", 0.38], ["tablet", 0.07]];
export const PLANS = [["free", 0.76], ["pro", 0.18], ["team", 0.06]];
export const PAGES = ["/", "/pricing", "/features", "/docs", "/blog", "/signup", "/dashboard", "/integrations"];
export const ACTIONS = [
  "signup_start", "signup_complete", "activate", "invite_sent",
  "upgrade_view", "upgrade_complete", "export_csv", "integration_connect",
];
export const FUNNEL = ["page_view", "signup_start", "signup_complete", "activate"];

/** Small, fast, seedable PRNG (mulberry32). */
export function createRng(seed = 20261028) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function weighted(rng, pairs) {
  let roll = rng();
  for (const [value, weight] of pairs) {
    if ((roll -= weight) <= 0) return value;
  }
  return pairs[pairs.length - 1][0];
}

function pick(rng, list) {
  return list[Math.floor(rng() * list.length)];
}

function startOfUtcDay(ts) {
  const d = new Date(ts);
  d.setUTCHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * @param {{seed?: number, userCount?: number, days?: number, now?: number, targetEvents?: number}} options
 * @returns {{events: object[], people: object[], meta: object}}
 */
export function generateDataset({
  seed = 20261028,
  userCount = 4000,
  days = 90,
  now = Date.now(),
  targetEvents = 120000,
} = {}) {
  const rng = createRng(seed);
  const today = startOfUtcDay(now);
  const firstDay = today - (days - 1) * DAY;
  const events = [];
  const people = [];
  let sessionSeq = 0;

  // Return-visit probability by days since signup: decays, then plateaus.
  const returnOffsets = [1, 2, 3, 4, 7, 10, 14, 21, 30, 45];
  const returnProbability = (d) => 0.35 * Math.exp(-d / 10) + 0.02;

  for (let u = 0; u < userCount; u++) {
    const userId = `u_${(1000 + u).toString(36)}`;
    // Growth: most users are recent (rng^1.35 skews toward small day offsets).
    const dayOffset = Math.floor(days * Math.pow(rng(), 1.35));
    const signupDay = today - dayOffset * DAY;
    const country = weighted(rng, COUNTRIES);
    const device = weighted(rng, DEVICES);
    const plan = weighted(rng, PLANS);
    const firstSeen = signupDay + Math.floor(8 + rng() * 14) * 3_600_000;
    people.push({ id: userId, firstSeen, country, device, plan });

    const base = { user: userId, country, device, plan };

    // ---- acquisition + activation on the first day ----------------------
    const firstSession = `s_${++sessionSeq}`;
    let t = firstSeen;
    const pagesInFirst = 4 + Math.floor(rng() * 6);
    for (let i = 0; i < pagesInFirst; i++) {
      events.push({ ...base, session: firstSession, name: "page_view", page: pick(rng, PAGES), ts: t });
      t += Math.floor(8_000 + rng() * 60_000);
    }
    const signedUp = rng() < 0.62;
    if (signedUp) {
      events.push({ ...base, session: firstSession, name: "signup_start", page: "/signup", ts: t });
      t += Math.floor(20_000 + rng() * 120_000);
      const completed = rng() < 0.82;
      if (completed) {
        events.push({ ...base, session: firstSession, name: "signup_complete", page: "/signup", ts: t });
        if (rng() < (plan === "free" ? 0.42 : 0.86)) {
          t += Math.floor(60_000 + rng() * 600_000);
          events.push({ ...base, session: firstSession, name: "activate", page: "/dashboard", ts: t });
        }
      }
    }

    // ---- return visits --------------------------------------------------
    for (const offset of returnOffsets) {
      const day = signupDay + offset * DAY;
      if (day > today) break;
      if (rng() > returnProbability(offset)) continue;
      const session = `s_${++sessionSeq}`;
      let when = day + Math.floor(7 + rng() * 15) * 3_600_000;
      const views = 6 + Math.floor(rng() * 10);
      for (let i = 0; i < views; i++) {
        events.push({ ...base, session, name: "page_view", page: pick(rng, PAGES), ts: when });
        when += Math.floor(6_000 + rng() * 45_000);
      }
      // A minority of sessions contain a product action.
      if (rng() < 0.55) {
        const action = pick(rng, ACTIONS);
        events.push({ ...base, session, name: action, page: action === "export_csv" ? "/dashboard" : "/", ts: when });
        if (action === "upgrade_view" && rng() < 0.35) {
          events.push({ ...base, session, name: "upgrade_complete", page: "/pricing", ts: when + 45_000 });
        }
      }
    }
  }

  events.sort((a, b) => a.ts - b.ts || (a.id ?? "").localeCompare(b.id ?? ""));
  for (let i = 0; i < events.length; i++) events[i].id = `e_${i.toString(36)}`;

  // Calibrate to the advertised dataset size without breaking ordering.
  if (events.length > targetEvents) events.length = targetEvents;
  while (events.length < targetEvents) {
    const person = people[Math.floor(rng() * people.length)];
    const ts = firstDay + Math.floor(rng() * (now - firstDay));
    events.push({
      id: `e_x${events.length}`,
      user: person.id, country: person.country, device: person.device, plan: person.plan,
      session: `s_x${events.length}`, name: "page_view", page: pick(rng, PAGES), ts,
    });
  }
  events.sort((a, b) => a.ts - b.ts);

  return {
    events,
    people,
    meta: { seed, userCount, days, targetEvents, firstDay, today, generatedAt: now },
  };
}
