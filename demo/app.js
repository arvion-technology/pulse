// Pulse, demo application.
// All analytics come from ../src/analytics.js and the dataset from
// ../src/dataset.js; this file only handles rendering and interaction.
import {
  dailySeries, funnelAnalysis, retention, topN, distribution, sessionStats,
  movingAverage, periodDelta, describeDelta, DAY,
} from "../src/analytics.js";
import { generateDataset, FUNNEL, ACTIONS } from "../src/dataset.js";

const $ = A.$, $$ = A.$$, el = A.el, fmt = A.fmt;

const state = {
  range: 30,
  view: "overview",
  steps: [...FUNNEL],
  eventPage: 0,
  filters: { q: "", name: "", country: "", device: "" },
  live: true,
};

let DATA = generateDataset({ now: Date.now() });
let cache = { range: null, events: null };

/* ------------------------------------------------------------------ data */

function rangeEvents(days = state.range) {
  if (cache.range === days && cache.events) return cache.events;
  const end = Date.now();
  const start = end - days * DAY;
  cache = { range: days, events: DATA.events.filter((e) => e.ts >= start && e.ts <= end) };
  return cache.events;
}

function previousEvents(days = state.range) {
  const end = Date.now() - days * DAY;
  return DATA.events.filter((e) => e.ts > end - days * DAY && e.ts <= end);
}

/**
 * Week-1 retention split by plan and device, the "what correlates with
 * coming back" panel. Only includes cohorts old enough to observe week 1.
 */
function retentionDrivers() {
  const first = new Map();
  for (const e of DATA.events) {
    const prev = first.get(e.user);
    if (prev === undefined || e.ts < prev) first.set(e.user, e.ts);
  }
  const retained = new Set();
  for (const e of DATA.events) {
    const f = first.get(e.user);
    if (f !== undefined && e.ts - f >= 7 * DAY && e.ts - f < 14 * DAY) retained.add(e.user);
  }
  const groups = new Map();
  for (const person of DATA.people) {
    const f = first.get(person.id);
    if (f === undefined || Date.now() - f < 14 * DAY) continue;
    for (const key of ["plan", "device"]) {
      const id = `${key}:${person[key]}`;
      if (!groups.has(id)) groups.set(id, { key, value: person[key], total: 0, kept: 0 });
      const entry = groups.get(id);
      entry.total++;
      if (retained.has(person.id)) entry.kept++;
    }
  }
  return [...groups.values()]
    .filter((g) => g.total >= 60)
    .map((g) => ({ ...g, rate: g.kept / g.total }))
    .sort((a, b) => b.rate - a.rate);
}

/* ---------------------------------------------------------------- pieces */

function kpiCard({ label, value, sub, delta, spark, tone = "gold" }) {
  const d = describeDelta(delta);
  return el("div", { class: "card" },
    el("div", { class: "stat" },
      el("div", { class: "stat-label", text: label }),
      el("div", { class: "row", style: "align-items:baseline;gap:10px" },
        el("div", { class: "stat-value " + tone, text: value }),
        d.tone !== "flat"
          ? el("span", { class: `stat-delta ${d.tone}`, text: `${d.tone === "up" ? "▲" : "▼"} ${Math.abs(d.pct * 100).toFixed(1)}%` })
          : null),
      el("div", { class: "row", style: "justify-content:space-between;align-items:flex-end" },
        el("span", { class: "small muted", text: sub }),
        spark ? A.sparkline(spark, { width: 92, height: 28, color: d.tone === "down" ? "#f87171" : "#f5c26b" }) : null)));
}

function eventBadge(name) {
  const tone = name === "signup_complete" ? "green"
    : name === "activate" ? "gold"
      : name === "page_view" ? "" : "blue";
  return el("span", { class: "badge " + tone, text: name });
}

function renderKpis(events) {
  const series = dailySeries(events, { days: state.range, end: Date.now() });
  const delta = periodDelta(events, { days: state.range, end: Date.now() });
  const conv = funnelAnalysis(events, state.steps, { windowDays: state.range });
  const prevConv = funnelAnalysis(previousEvents(), state.steps, { windowDays: state.range }).steps.at(-1);
  const last = conv.steps.at(-1);
  const sessions = sessionStats(events);
  const signups = events.filter((e) => e.name === "signup_complete").length;
  const prevSignups = previousEvents().filter((e) => e.name === "signup_complete").length;

  return [
    kpiCard({
      label: "Active users", value: fmt.compact(new Set(events.map((e) => e.user)).size),
      sub: `${state.range}-day unique`, delta: delta.users.delta,
      spark: series.map((d) => d.users),
    }),
    kpiCard({
      label: "Sessions", value: fmt.compact(sessions.sessions),
      sub: `${sessions.perUser.toFixed(1)} per user`, delta: delta.events.delta,
      spark: series.map((d) => d.sessions), tone: "blue",
    }),
    kpiCard({
      label: "Signups", value: fmt.compact(signups),
      sub: "completed signup", delta: prevSignups ? (signups - prevSignups) / prevSignups : 0,
      spark: series.map((d) => d.signups),
    }),
    kpiCard({
      label: `Conversion · ${state.steps.at(-1).replace(/_/g, " ")}`,
      value: fmt.pct(last.fromStart),
      sub: `${conv.steps.length}-step funnel`,
      delta: prevConv && prevConv.users ? (last.fromStart - prevConv.fromStart) / prevConv.fromStart : 0,
      spark: series.map((d) => d.users), tone: "green",
    }),
  ];
}

function renderOverview() {
  const events = rangeEvents();
  $("#kpis").replaceChildren(...renderKpis(events));

  const series = dailySeries(events, { days: state.range, end: Date.now() });
  const labels = series.map((d) => new Date(d.date + "T00:00:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }));
  $("#chart-users").replaceChildren(A.lineChart({
    series: [
      { name: "DAU", data: movingAverage(series.map((d) => d.users), 3) },
      { name: "Sessions", data: movingAverage(series.map((d) => d.sessions), 3), color: "#3a7bff", area: false },
    ],
    labels, width: 760, height: 236,
  }));

  const devices = distribution(events, "device");
  const colors = ["#f5c26b", "#3a7bff", "#34d399", "#a78bfa"];
  $("#donut-devices").replaceChildren(A.donut({
    slices: devices.map((d, i) => ({ label: d.value, value: d.count, color: colors[i % colors.length] })),
    centerValue: fmt.compact(events.length),
    centerLabel: "events",
  }));
  $("#device-legend").replaceChildren(...devices.map((d, i) =>
    el("div", { class: "row", style: "gap:8px" },
      el("i", { style: `width:9px;height:9px;border-radius:3px;background:${colors[i % colors.length]}` }),
      el("span", { text: fmt.title(d.value) }),
      el("span", { class: "spacer" }),
      el("span", { class: "mono muted", text: fmt.pct(d.share, 0) }))));

  const pages = topN(events.filter((e) => e.name === "page_view"), "page", 6);
  $("#top-pages").replaceChildren(A.barList({ rows: pages.map((p) => ({ label: p.value, value: p.count })) }));

  const recent = DATA.events.slice(-9).reverse();
  $("#recent-events").replaceChildren(A.dataTable({
    columns: [
      { label: "Time", width: "90px", render: (r) => el("span", { class: "mono muted", text: fmt.relative(r.ts) }) },
      { label: "Event", render: (r) => eventBadge(r.name) },
      { label: "User", render: (r) => el("span", { class: "mono", text: r.user }) },
      { label: "Where", align: "right", render: (r) => el("span", { class: "small muted", text: `${r.country} · ${r.device}` }) },
    ],
    rows: recent,
  }));
}

/* -------------------------------------------------------------- funnels */

function renderFunnels() {
  const events = rangeEvents();
  const options = ["page_view", ...ACTIONS];
  const stepsHost = $("#funnel-steps");
  stepsHost.replaceChildren(...state.steps.map((step, i) =>
    el("div", { class: "row", style: "gap:8px" },
      el("span", { class: "avatar sm", style: "background:var(--surface-3);color:var(--muted);border-color:var(--line-strong)", text: String(i + 1) }),
      el("select", {
        class: "select", "aria-label": `Step ${i + 1}`,
        onchange: (e) => { state.steps[i] = e.target.value; renderFunnels(); },
      }, ...options.map((o) => el("option", { value: o, selected: o === step ? "" : null, text: o }))),
      el("button", {
        class: "btn icon ghost", "aria-label": "Remove step", disabled: state.steps.length <= 2 ? "" : null,
        onclick: () => { state.steps.splice(i, 1); renderFunnels(); }, text: "✕",
      }))));
  $("#funnel-count").textContent = `${state.steps.length} steps`;
  $("#funnel-window").textContent = `within ${state.range} days of the first step`;

  const analysis = funnelAnalysis(events, state.steps, { windowDays: state.range, breakdown: "device" });
  const last = analysis.steps.at(-1);
  $("#funnel-total").textContent = fmt.pct(last.fromStart);

  $("#funnel-bars").replaceChildren(...analysis.steps.map((s, i) => {
    const width = Math.max(2, s.fromStart * 100);
    return el("div", {},
      el("div", { class: "row", style: "margin-bottom:6px" },
        el("span", { class: "small", style: "font-weight:600", text: `${i + 1}. ${s.step}` }),
        el("span", { class: "spacer" }),
        el("span", { class: "mono small", text: `${fmt.num(s.users)} users` }),
        el("span", { class: "badge " + (i === 0 ? "" : s.fromPrev > 0.5 ? "green" : "gold"), text: i === 0 ? "entry" : fmt.pct(s.fromPrev) })),
      el("div", { class: "progress" }, el("i", { style: `width:${width}%` })),
      i < analysis.steps.length - 1
        ? el("div", { class: "small muted", style: "margin-top:5px", text: `▼ ${fmt.num(s.users - analysis.steps[i + 1].users)} dropped · ${fmt.pct(1 - s.fromPrev)}` })
        : el("div", { class: "small muted", style: "margin-top:5px", text: `${fmt.pct(s.fromStart)} of entrants completed the funnel` }));
  }));

  $("#funnel-breakdown").replaceChildren(A.dataTable({
    columns: [
      { label: "Transition", render: (r) => el("span", { class: "mono small", text: `${r.from} → ${r.to}` }) },
      { label: "Stalled", align: "right", render: (r) => el("span", { class: "strong", text: fmt.num(r.users) }) },
      {
        label: "Mostly", align: "right", render: (r) => {
          const [device, count] = Object.entries(r.breakdown).sort((a, b) => b[1] - a[1])[0] || [", ", 0];
          return el("span", { class: "small muted", text: `${fmt.title(device)} · ${fmt.pct(count / Math.max(1, r.users), 0)}` });
        },
      },
    ],
    rows: analysis.drops,
    empty: "Everyone converted, try narrower steps.",
  }));
}

/* ------------------------------------------------------------- retention */

function renderRetention() {
  const { cohorts, curve } = retention(DATA.events, { cohorts: 8, weeks: 8, now: Date.now() });
  const table = el("table", { class: "table", style: "min-width:640px" });
  table.append(el("thead", {}, el("tr", {},
    el("th", { text: "Cohort" }), el("th", { text: "Users" }),
    ...Array.from({ length: 8 }, (_, w) => el("th", { text: `W${w}`, class: "num" })))));
  const tbody = el("tbody");
  for (const row of cohorts) {
    const tr = el("tr", {},
      el("td", { class: "strong", text: row.label }),
      el("td", { class: "mono muted", text: fmt.num(row.size) }));
    row.retention.forEach((value) => {
      if (value === null) { tr.append(el("td", { class: "num muted", text: "·" })); return; }
      const alpha = 0.12 + value * 0.78;
      tr.append(el("td", {
        class: "num",
        style: `background:rgba(245,194,107,${alpha.toFixed(2)});color:${value > 0.45 ? "#1a1405" : "var(--text)"};font-weight:600`,
        text: fmt.pct(value, 0),
      }));
    });
    tbody.append(tr);
  }
  table.append(tbody);
  $("#cohort-table").replaceChildren(el("div", { class: "table-wrap" }, table));

  $("#retention-curve").replaceChildren(A.lineChart({
    series: [{ name: "Retention", data: curve.map((v) => (v ?? 0) * 100) }],
    labels: curve.map((_, i) => `W${i}`),
    width: 420, height: 190,
    yFormat: (v) => Math.round(v) + "%",
  }));

  const drivers = retentionDrivers();
  $("#retention-drivers").replaceChildren(A.barList({
    rows: drivers.map((d) => ({ label: `${fmt.title(d.value)} · ${d.key}`, value: Math.round(d.rate * 100) })),
    format: (v) => v + "%",
  }));
}

/* ---------------------------------------------------------- event table */

function filteredEvents() {
  const { q, name, country, device } = state.filters;
  const needle = q.trim().toLowerCase();
  return DATA.events.filter((e) => {
    if (name && e.name !== name) return false;
    if (country && e.country !== country) return false;
    if (device && e.device !== device) return false;
    if (!needle) return true;
    return e.name.includes(needle) || e.user.toLowerCase().includes(needle) || (e.page || "").toLowerCase().includes(needle);
  });
}

function renderEventFilters() {
  const fill = (id, values, current, label) => {
    $(id).replaceChildren(el("option", { value: "", text: label }),
      ...values.map((v) => el("option", { value: v, selected: v === current ? "" : null, text: v })));
  };
  fill("#event-name", [...new Set(DATA.events.map((e) => e.name))].sort(), state.filters.name, "All events");
  fill("#event-country", [...new Set(DATA.events.map((e) => e.country))].sort(), state.filters.country, "All countries");
  fill("#event-device", ["desktop", "mobile", "tablet"], state.filters.device, "All devices");
}

function renderEvents() {
  const rows = filteredEvents().slice().reverse();
  const perPage = 14;
  const pages = Math.max(1, Math.ceil(rows.length / perPage));
  state.eventPage = Math.min(state.eventPage, pages - 1);
  const slice = rows.slice(state.eventPage * perPage, state.eventPage * perPage + perPage);

  $("#event-total").textContent = `${fmt.num(rows.length)} events`;
  $("#event-page-info").textContent = `Page ${state.eventPage + 1} of ${pages} · showing ${slice.length}`;
  $("#event-table").replaceChildren(A.dataTable({
    columns: [
      { label: "Timestamp", width: "160px", render: (r) => el("span", { class: "mono small", text: new Date(r.ts).toISOString().replace("T", " ").slice(0, 19) }) },
      { label: "Event", render: (r) => eventBadge(r.name) },
      { label: "User", render: (r) => el("span", { class: "mono small", text: r.user }) },
      { label: "Page", render: (r) => el("span", { class: "small muted", text: r.page || ", " }) },
      { label: "Country", render: (r) => el("span", { class: "small muted", text: r.country }) },
      { label: "Device", align: "right", render: (r) => el("span", { class: "badge", text: r.device }) },
    ],
    rows: slice,
    onRowClick: (r) => A.modal({
      title: "Event inspector",
      body: el("div", { class: "col", style: "gap:14px" },
        el("div", { class: "row wrap" }, eventBadge(r.name), el("span", { class: "badge", text: r.user }), el("span", { class: "badge", text: r.device })),
        el("pre", { class: "code", text: JSON.stringify(r, null, 2) })),
      actions: [{ label: "Close" }],
    }),
  }));
}

/* ----------------------------------------------------------------- live */

let liveTimer = null;

function renderLive() {
  const pool = DATA.events.slice(-1500);
  const activeUsers = new Set(DATA.events.slice(-2000).map((e) => e.user)).size;
  const top = topN(pool, "name", 1)[0];
  const kpis = [
    ["Events / min", fmt.num(84 + Math.round(Math.random() * 24)), "streaming now"],
    ["Top event", top ? top.value.replace(/_/g, " ") : ", ", "last 2k events"],
    ["Active sessions", fmt.num(Math.round(activeUsers * 0.42)), "right now"],
  ].map(([label, value, sub]) => el("div", { class: "card" },
    el("div", { class: "stat" },
      el("div", { class: "stat-label", text: label }),
      el("div", { class: "stat-value gold", style: "font-size:24px", text: value }),
      el("div", { class: "small muted", text: sub }))));
  $("#live-kpis").replaceChildren(...kpis);

  if (liveTimer) clearInterval(liveTimer);
  const tape = $("#live-tape");
  tape.replaceChildren();
  const push = () => {
    const e = pool[Math.floor(Math.random() * pool.length)];
    tape.prepend(el("div", { class: "row", style: "padding:10px 14px;border-bottom:1px solid var(--line);font-size:13px" },
      el("span", { class: "mono muted", style: "width:74px", text: new Date().toLocaleTimeString("en-US", { hour12: false }) }),
      eventBadge(e.name),
      el("span", { class: "mono small", text: e.user }),
      el("span", { class: "spacer" }),
      el("span", { class: "small muted", text: `${e.country} · ${e.device} · ${e.page || ", "}` })));
    while (tape.childElementCount > 40) tape.lastElementChild.remove();
  };
  for (let i = 0; i < 12; i++) push();
  if (state.live) liveTimer = setInterval(push, 900);
  $("#live-toggle").textContent = state.live ? "Pause" : "Resume";
}

/* -------------------------------------------------------------- routing */

const VIEWS = ["overview", "funnels", "retention", "events", "live", "settings"];

function route() {
  const requested = (location.hash || "#overview").slice(1);
  state.view = VIEWS.includes(requested) ? requested : "overview";
  $$("[data-view-panel]").forEach((panel) => { panel.hidden = panel.dataset.viewPanel !== state.view; });
  $$("[data-view]").forEach((a) => a.classList.toggle("active", a.dataset.view === state.view));

  if (state.view === "overview") renderOverview();
  else if (state.view === "funnels") renderFunnels();
  else if (state.view === "retention") renderRetention();
  else if (state.view === "events") { renderEventFilters(); renderEvents(); }
  else if (state.view === "live") renderLive();
  else if (state.view === "settings") renderSettings();
  window.scrollTo({ top: 0 });
}

function renderSettings() {
  const events = DATA.events;
  const set = (id, value) => { const node = document.getElementById(id); if (node) node.textContent = value; };
  set("dataset-events", fmt.num(events.length));
  set("dataset-users", fmt.num(DATA.people.length));
}

/* --------------------------------------------------------------- events */

function wire() {
  A.timeAgoClock($("#live-clock .mono"));

  $$("#range-tabs .tab").forEach((tab) => tab.addEventListener("click", () => {
    state.range = Number(tab.dataset.range);
    $$("#range-tabs .tab").forEach((t) => t.classList.toggle("active", t === tab));
    cache = { range: null, events: null };
    route();
    A.toast(`Range set to ${state.range} days`, "success", 1600);
  }));

  $("#export-overview").addEventListener("click", () => {
    const series = dailySeries(rangeEvents(), { days: state.range, end: Date.now() });
    A.download(`pulse-${state.range}d.csv`, A.toCSV(series), "text/csv");
    A.toast("Exported the daily series as CSV", "success");
  });

  $("#refresh").addEventListener("click", () => {
    cache = { range: null, events: null };
    route();
    A.toast(`Recomputed from ${fmt.num(DATA.events.length)} events`, "success");
  });

  $("#add-step").addEventListener("click", () => {
    if (state.steps.length >= 6) return A.toast("Six steps is the maximum", "error");
    const used = new Set(state.steps);
    state.steps.push(ACTIONS.find((a) => !used.has(a)) || "invite_sent");
    renderFunnels();
  });

  $("#event-search").addEventListener("input", A.debounce((e) => {
    state.filters.q = e.target.value; state.eventPage = 0; renderEvents();
  }, 200));
  for (const [id, key] of [["#event-name", "name"], ["#event-country", "country"], ["#event-device", "device"]]) {
    $(id).addEventListener("change", (e) => { state.filters[key] = e.target.value; state.eventPage = 0; renderEvents(); });
  }
  $("#event-clear").addEventListener("click", () => {
    state.filters = { q: "", name: "", country: "", device: "" };
    $("#event-search").value = "";
    renderEventFilters(); state.eventPage = 0; renderEvents();
  });
  $("#event-prev").addEventListener("click", () => { state.eventPage = Math.max(0, state.eventPage - 1); renderEvents(); });
  $("#event-next").addEventListener("click", () => { state.eventPage++; renderEvents(); });

  $("#live-toggle").addEventListener("click", () => {
    state.live = !state.live;
    if (state.live) renderLive();
    else { if (liveTimer) { clearInterval(liveTimer); liveTimer = null; } $("#live-toggle").textContent = "Resume"; }
  });

  $("#global-search").addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    state.filters = { q: e.target.value, name: "", country: "", device: "" };
    state.eventPage = 0;
    location.hash = "#events";
    route();
  });

  $("#reset-data").addEventListener("click", () => {
    DATA = generateDataset({ now: Date.now(), seed: Math.floor(Math.random() * 1e6) });
    cache = { range: null, events: null };
    A.toast("Dataset regenerated with a new seed", "success");
    route();
  });

  $$(".switch").forEach((sw) => sw.addEventListener("click", () => {
    sw.setAttribute("aria-checked", sw.getAttribute("aria-checked") === "true" ? "false" : "true");
  }));

  window.addEventListener("hashchange", route);
}

wire();
route();
