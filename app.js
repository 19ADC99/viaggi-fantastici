/* Exploration dashboard.
 *
 * Data: window.EXPLORATION (data.js, written by strava_code.spatial_network.export_web)
 *   activities  compact rows, see EXPLORATION.fields
 *   athletes    [{id, label}] in display order (one per Strava export)
 *   network     GeoJSON FeatureCollection of path segments with activity_ids
 *   training    {title, goal_km, next_race} for the training-plan section
 *
 * Two activities recorded on the same outing by two people (`partner`) form one
 * "outing". The people switch picks what the statistics count:
 *   All          every outing once (a joint one counts once, metrics = mean of both)
 *   Together     joint outings only; on the map, only paths both of you covered
 *   <person>     that person's own activities (optionally solo ones only)
 *
 * One filter row (people + period + activity types) scopes everything: tiles,
 * charts, map and lists. The search box only narrows the lists and gallery.
 */
"use strict";

// ------------------------------------------------------------------ data

const D = window.EXPLORATION;
const GROUPS = ["run", "walk", "hike", "ride", "swim", "sail", "other"];   // fixed colour order
const LABEL = { run: "Run", walk: "Walk", hike: "Hike", ride: "Ride", swim: "Swim", sail: "Sail", other: "Other" };
const METRIC = {
  km:    { label: "Distance",   unit: "km", get: a => a.km || 0,     digits: 0 },
  hours: { label: "Time",       unit: "h",  get: a => a.hours || 0,  digits: 0 },
  count: { label: "Activities", unit: "",   get: () => 1,            digits: 0 },
  elev:  { label: "Elevation",  unit: "m",  get: a => a.elev || 0,   digits: 0 },
};
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const ACTS = D.activities.map(row => {
  const o = Object.fromEntries(D.fields.map((f, i) => [f, row[i]]));
  const d = o.start ? new Date(o.start + "Z") : null;
  return {
    id: o.id, name: o.name || "(untitled)", type: o.type || "", group: o.group,
    date: d, year: d ? d.getUTCFullYear() : null, month: d ? d.getUTCMonth() : null,
    day: d ? d.getUTCDate() : null,
    km: o.km, hours: o.moving_s != null ? o.moving_s / 3600 : null, elev: o.elev_m,
    elapsedH: o.elapsed_s != null ? o.elapsed_s / 3600 : null,
    onMap: o.on_map, cell: o.cell, mediaAt: o.media_at || null,
    athlete: o.athlete ?? null, partner: o.partner ?? null, train: o.train || null, race: !!o.race,
  };
}).filter(a => a.date).sort((a, b) => a.date - b.date);
const BY_ID = new Map(ACTS.map(a => [a.id, a]));

// people: configured order first, then any other export
const LABEL_OF = new Map((D.athletes || []).map(p => [p.id, p.label]));
const PEOPLE = [...LABEL_OF.keys(),
  ...[...new Set(ACTS.map(a => a.athlete))].filter(id => id != null && !LABEL_OF.has(id)).sort((a, b) => a - b)]
  .filter(id => ACTS.some(a => a.athlete === id));
const MULTI = PEOPLE.length > 1;
const who = id => LABEL_OF.get(id) ?? (id == null ? "" : String(id));
const rank = id => { const i = PEOPLE.indexOf(id); return i < 0 ? 99 : i; };
const TOGETHER_LABEL = D.together_label || `${PEOPLE.map(who).join(" & ")} together`;

// photos / videos, grouped by activity (Strava export order)
const MEDIA = (D.media || []).map(row => Object.fromEntries((D.media_fields || []).map((f, i) => [f, row[i]])));
const MEDIA_BY_ACT = new Map();
for (const m of MEDIA) {
  if (!BY_ID.has(m.activity_id)) continue;
  if (!MEDIA_BY_ACT.has(m.activity_id)) MEDIA_BY_ACT.set(m.activity_id, []);
  MEDIA_BY_ACT.get(m.activity_id).push(m);
}

// outings: an activity alone, or two activities recorded together
const avg = (xs, f) => { const v = xs.map(f).filter(x => x != null); return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null; };
const OUTINGS = [];
for (const a of ACTS) {
  if (a.outing) continue;
  const p = a.partner != null ? BY_ID.get(a.partner) : null;
  const members = p && !p.outing ? [a, p].sort((x, y) => rank(x.athlete) - rank(y.athlete)) : [a];
  const lead = members[0], gps = members.filter(m => m.onMap);
  const o = {
    key: lead.id, members, together: members.length > 1,
    name: lead.name, type: lead.type, group: lead.group,
    date: a.date, year: a.year, month: a.month, day: a.day,          // a is the earlier one (ACTS is sorted)
    km: avg(members, m => m.km), hours: avg(members, m => m.hours), elev: avg(members, m => m.elev),
    onMap: gps.length > 0, cell: gps[0]?.cell || null,
    train: members.find(m => m.train)?.train || null, race: members.some(m => m.race),
    media: members.flatMap(m => MEDIA_BY_ACT.get(m.id) || []),        // both people's photos together
    mediaAt: members.find(m => m.mediaAt)?.mediaAt || null,
  };
  for (const m of members) m.outing = o;
  OUTINGS.push(o);
}
for (const a of ACTS) {
  a.members = [a]; a.key = a.id;
  a.together = a.outing.together;
  a.mate = a.outing.members.find(m => m !== a) || null;
}
const outingOf = u => u.outing || u;
const mediaOf = u => outingOf(u).media;
function mediaSummary(u) {
  const ms = mediaOf(u), p = ms.filter(m => m.kind === "photo").length, v = ms.length - p;
  return [p && `${p} photo${p > 1 ? "s" : ""}`, v && `${v} video${v > 1 ? "s" : ""}`].filter(Boolean).join(", ");
}

const PRESENT = GROUPS.filter(g => ACTS.some(a => a.group === g));
const SEGMENTS = D.network.features;
const SEG_BY_ID = new Map(SEGMENTS.map(f => [f.properties.segment_id, f]));

// training plan ("W2.3" = week 2, run 3) and race
const T = D.training || {};
const GOAL = T.goal_km || 20;
const TRAIN = ACTS.filter(a => a.train);
const RACES = ACTS.filter(a => a.race);
const HAS_PLAN = TRAIN.length + RACES.length > 0;

// ------------------------------------------------------------------ state

const state = {
  people: "all",                 // "all" | "together" | "<athlete id>"
  soloOnly: false,               // with a person: hide the outings shared with the other
  period: "all",                 // "all" | "Y2025" | "M2025-02" (month index 0-11)
  types: new Set(PRESENT),
  trainingOnly: false,           // "20 km plan" chip
  trainingOpen: false,           // training section expanded
  metric: "km",
  bucket: "month",
  search: "",
  sort: "date-desc",
  selected: null,                // activity id; its whole outing is selected
  tab: "list",                   // "list" | "media"
  showMediaOnMap: true,
};

// ------------------------------------------------------------------ helpers

const $ = id => document.getElementById(id);
const css = name => getComputedStyle(document.querySelector(".viz-root")).getPropertyValue(name).trim();
const colour = g => css("--" + g);
const fmt = (v, digits = 0) => v == null ? "–" :
  v.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits });
const compact = v => v >= 10000 ? fmt(v / 1000, 1) + "k" : fmt(v);
const dateLabel = d => `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
const hm = h => h == null ? "–" : `${Math.floor(h)}h ${String(Math.round((h % 1) * 60)).padStart(2, "0")}m`;
function hms(h) {
  if (h == null) return "–";
  const s = Math.round(h * 3600);
  return `${Math.floor(s / 3600)}:${String(Math.floor(s / 60) % 60).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}
const mmss = min => min == null ? "–" : `${Math.floor(min)}:${String(Math.round((min % 1) * 60) % 60).padStart(2, "0")}`;
const paceOf = (a, hours = a.hours) => a.km && hours ? (hours * 60) / a.km : null;          // min/km
const onFoot = a => a.group === "run" || a.group === "walk" || a.group === "hike";
const speedText = a => onFoot(a)
  ? (paceOf(a) ? `${mmss(paceOf(a))} /km` : "–")
  : (a.km && a.hours ? `${fmt(a.km / a.hours, 1)} km/h` : "–");

function el(tag, attrs = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null) continue;
    if (k === "class") n.className = v;
    else if (k === "style") n.style.cssText = v;
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v);
  }
  for (const c of children.flat()) if (c != null && c !== false) n.append(c);   // strings become text nodes: no HTML injection
  return n;
}
const svgEl = (tag, attrs = {}) => {
  const n = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  return n;
};
const key = g => el("i", { class: "key", style: `background:${colour(g)}` });
const heart = mate => el("span", { class: "heart", title: mate ? `Together with ${who(mate.athlete)}` : "Together" }, "♥");

// person marks: first person a filled dot, second a ring, others a square
function personMark(athlete, x, y, r = 4.5) {
  const i = rank(athlete), accent = css("--accent"), surface = css("--surface-1");
  if (i === 1) return svgEl("circle", { cx: x, cy: y, r: r - 0.6, fill: surface, stroke: accent, "stroke-width": 2 });
  if (i >= 2 && i < 99) return svgEl("rect", { x: x - r + 0.5, y: y - r + 0.5, width: 2 * r - 1, height: 2 * r - 1, fill: accent, stroke: surface, "stroke-width": 1 });
  return svgEl("circle", { cx: x, cy: y, r, fill: accent, stroke: surface, "stroke-width": 1.5 });
}
function markIcon(athlete) {
  const s = svgEl("svg", { width: 12, height: 12, viewBox: "0 0 12 12", class: "mark", "aria-hidden": "true" });
  s.append(personMark(athlete, 6, 6, 4.5));
  return s;
}

function periodOf(a) {
  if (state.period === "all") return true;
  if (state.period[0] === "Y") return a.year === +state.period.slice(1);
  const [y, m] = state.period.slice(1).split("-").map(Number);
  return a.year === y && a.month === m;
}

const sharedView = () => state.people === "all" || state.people === "together";
/** What the statistics count in the current people view: outings or one person's activities. */
function units() {
  if (state.people === "all") return OUTINGS;
  if (state.people === "together") return OUTINGS.filter(o => o.together);
  const id = Number(state.people);
  return ACTS.filter(a => a.athlete === id && !(state.soloOnly && a.together));
}
const isTraining = u => !!(u.train || u.race);
const inFilter = u => state.types.has(u.group) && periodOf(u) && (!state.trainingOnly || isTraining(u));
const filtered = () => units().filter(inFilter);
const selectedActs = () => BY_ID.get(state.selected)?.outing.members || [];

function periodLabel(p = state.period) {
  if (p === "all") return "All time";
  if (p[0] === "Y") return p.slice(1);
  const [y, m] = p.slice(1).split("-").map(Number);
  return `${MONTHS[m]} ${y}`;
}
const viewLabel = () => state.people === "all" ? "" : state.people === "together" ? TOGETHER_LABEL
  : `${who(Number(state.people))}${state.soloOnly ? " solo" : ""}`;

function niceTicks(max, count = 4) {
  if (max <= 0) return [0];
  const raw = max / count, mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map(s => s * mag).find(s => s >= raw);
  const ticks = [];
  for (let v = 0; v <= max + step * 0.999; v += step) ticks.push(v);
  return ticks;
}

// ------------------------------------------------------------------ tooltip

const tip = $("tooltip");
function showTip(evt, head, rows, total) {
  tip.replaceChildren(el("div", { class: "t-head" }, head));
  for (const r of rows) {
    tip.append(el("div", { class: "row" },
      r.icon || el("i", { class: "line-key", style: `background:${r.colour}` }), r.label, el("b", {}, r.value)));
  }
  if (total) tip.append(el("div", { class: "row total" }, el("i"), total.label, el("b", {}, total.value)));
  tip.hidden = false;
  const pad = 14, w = tip.offsetWidth, h = tip.offsetHeight;
  let x = evt.clientX + pad, y = evt.clientY + pad;
  if (x + w > innerWidth - 8) x = evt.clientX - w - pad;
  if (y + h > innerHeight - 8) y = evt.clientY - h - pad;
  tip.style.left = x + "px"; tip.style.top = y + "px";
}
const hideTip = () => { tip.hidden = true; };

// ------------------------------------------------------------------ filters

function buildFilters() {
  // people
  $("people-wrap").hidden = !MULTI;
  if (MULTI) {
    const opts = [["all", "All"], ["together", TOGETHER_LABEL], ...PEOPLE.map(id => [String(id), who(id)])];
    $("people").replaceChildren(...opts.map(([v, t]) => el("button", {
      "data-v": v, "aria-pressed": String(state.people === v), class: v === "together" ? "together" : null,
    }, t)));
    $("solo-wrap").hidden = sharedView();
    $("solo").checked = state.soloOnly;
  }

  const years = [...new Set(ACTS.map(a => a.year))].sort((a, b) => b - a);
  const sel = $("period");
  const opts = [["all", "All time"], ...years.map(y => ["Y" + y, String(y)])];
  if (state.period[0] === "M") opts.push([state.period, periodLabel()]);
  sel.replaceChildren(...opts.map(([v, t]) => el("option", { value: v }, t)));
  sel.value = state.period;

  const inScope = units().filter(u => periodOf(u) && (!state.trainingOnly || isTraining(u)));
  const chips = $("types");
  chips.replaceChildren(
    el("button", { class: "chip", "aria-pressed": state.types.size === PRESENT.length ? "true" : "false",
                   onclick: () => { state.types = new Set(PRESENT); update({ fit: true }); } }, "All"),
    ...PRESENT.map(g => el("button", {
      class: "chip", "data-group": g, "aria-pressed": state.types.has(g) && state.types.size < PRESENT.length ? "true" : "false",
      title: "Click to show only this type; Shift-click to add or remove it",
      onclick: e => {
        if (e.shiftKey) {
          state.types.has(g) ? state.types.delete(g) : state.types.add(g);
          if (!state.types.size) state.types = new Set(PRESENT);
        } else {
          state.types = state.types.size === 1 && state.types.has(g) ? new Set(PRESENT) : new Set([g]);
        }
        update({ fit: true });
      },
    }, key(g), LABEL[g], el("span", { class: "n" }, String(inScope.filter(u => u.group === g).length)))),
    HAS_PLAN ? el("button", {
      class: "chip chip-plan", "aria-pressed": String(state.trainingOnly),
      title: `Only the runs of the plan (${T.title || "training"})`,
      onclick: () => {
        state.trainingOnly = !state.trainingOnly;
        setTrainingOpen(state.trainingOnly);     // the chip opens the section; turning it off folds it back
        update({ fit: true });
      },
    }, el("span", { class: "flag", "aria-hidden": "true" }, "⚑"), `${fmt(GOAL)} km plan`,
       el("span", { class: "n" }, String(units().filter(u => periodOf(u) && isTraining(u)).length))) : null,
  );
}

$("people").addEventListener("click", e => {
  const b = e.target.closest("button"); if (!b) return;
  state.people = b.dataset.v;
  update({ fit: true });
});
$("solo").addEventListener("change", e => { state.soloOnly = e.target.checked; update({ fit: true }); });

$("period").addEventListener("change", e => {
  state.period = e.target.value;
  if (state.period[0] === "Y" && state.bucket === "year") state.bucket = "month";
  update({ fit: true });
});

for (const id of ["metric", "bucket"]) {
  $(id).addEventListener("click", e => {
    const b = e.target.closest("button"); if (!b) return;
    state[id] = b.dataset.v;
    update();
  });
}

$("table-toggle").addEventListener("click", e => {
  const open = $("bars-table").hidden;
  $("bars-table").hidden = !open; $("bars").hidden = open;
  e.target.setAttribute("aria-expanded", open); e.target.textContent = open ? "Chart" : "Table";
});

$("search").addEventListener("input", e => { state.search = e.target.value.trim().toLowerCase(); renderList(); renderGallery(); });
$("sort").addEventListener("change", e => { state.sort = e.target.value; renderList(); });

// ------------------------------------------------------------------ tiles

function tile(label, value, unit, sub, title) {
  return el("div", { class: "tile", title },
    el("div", { class: "label" }, label),
    el("div", { class: "value" }, value, unit ? el("span", { class: "unit" }, unit) : null),
    el("div", { class: "sub" }, sub));
}

function renderTiles(us) {
  const sum = f => us.reduce((s, a) => s + (f(a) || 0), 0);
  const km = sum(a => a.km), hours = sum(a => a.hours), elev = sum(a => a.elev);
  const longest = us.reduce((m, a) => (a.km || 0) > (m?.km || 0) ? a : m, null);
  const photos = fmt(us.filter(u => mediaOf(u).length).length);
  const together = us.filter(u => u.together).length;
  let sub;
  if (!MULTI || state.people === "together") sub = `${fmt(us.filter(a => a.onMap).length)} with a GPS track · ${photos} with photos`;
  else if (state.people === "all") sub = `${fmt(together)} together, counted once · ${photos} with photos`;
  else sub = state.soloOnly ? `${photos} with photos` : `${fmt(together)} with ${PEOPLE.filter(id => id !== Number(state.people)).map(who).join(", ")} · ${photos} with photos`;
  const meanNote = MULTI && sharedView() ? "An outing recorded by both of you counts once, with the average of the two recordings" : null;
  $("tiles").replaceChildren(
    tile("Activities", fmt(us.length), "", sub, meanNote),
    tile("Distance", fmt(km), "km", longest ? `longest ${fmt(longest.km, 1)} km` : "–", meanNote),
    tile("Moving time", fmt(hours), "h", us.length ? `${hm(hours / us.length)} per activity` : "–", meanNote),
    tile("Elevation gain", fmt(elev), "m", `${fmt(elev / 8849, 1)}× Everest`, meanNote),
  );
}

// ------------------------------------------------------------------ buckets

function buckets(acts) {
  // [{key, label, short, from, values: {group: v}, total}]
  const m = METRIC[state.metric];
  let list;
  if (state.period[0] === "M") {                                   // one month -> days
    const [y, mo] = state.period.slice(1).split("-").map(Number);
    const days = new Date(Date.UTC(y, mo + 1, 0)).getUTCDate();
    list = Array.from({ length: days }, (_, i) => ({
      key: i + 1, label: `${i + 1} ${MONTHS[mo]} ${y}`, short: String(i + 1),
      match: a => a.day === i + 1, drill: null }));
  } else if (state.bucket === "year" && state.period === "all") {
    const ys = ACTS.map(a => a.year);
    list = [];
    for (let y = Math.min(...ys); y <= Math.max(...ys); y++)
      list.push({ key: y, label: String(y), short: String(y), match: a => a.year === y, drill: "Y" + y });
  } else {                                                         // months
    let from, to;
    if (state.period[0] === "Y") { const y = +state.period.slice(1); from = [y, 0]; to = [y, 11]; }
    else {
      const ds = ACTS.map(a => a.year * 12 + a.month);
      const lo = Math.min(...ds), hi = Math.max(...ds);
      from = [Math.floor(lo / 12), lo % 12]; to = [Math.floor(hi / 12), hi % 12];
    }
    list = [];
    for (let i = from[0] * 12 + from[1]; i <= to[0] * 12 + to[1]; i++) {
      const y = Math.floor(i / 12), mo = i % 12;
      list.push({ key: i, label: `${MONTHS[mo]} ${y}`, short: mo === 0 || i === from[0] * 12 + from[1] ? `${MONTHS[mo]} ${String(y).slice(2)}` : MONTHS[mo],
                  first: mo === 0, match: a => a.year === y && a.month === mo, drill: `M${y}-${mo}` });
    }
  }
  for (const b of list) {
    b.values = Object.fromEntries(GROUPS.map(g => [g, 0]));
    for (const a of acts) if (b.match(a)) b.values[a.group] += m.get(a);
    b.total = GROUPS.reduce((s, g) => s + b.values[g], 0);
  }
  return list;
}

// ------------------------------------------------------------------ stacked columns

function renderBars(acts) {
  const m = METRIC[state.metric];
  const bs = buckets(acts);
  const unitTxt = m.unit ? ` (${m.unit})` : "";
  const per = state.period[0] === "M" ? "day" : (state.bucket === "year" && state.period === "all" ? "year" : "month");
  $("bars-title").textContent = `${m.label}${unitTxt} per ${per}${viewLabel() ? " · " + viewLabel() : ""}`;
  for (const id of ["metric", "bucket"])
    $(id).querySelectorAll("button").forEach(b => b.setAttribute("aria-pressed", b.dataset.v === state[id]));
  $("bucket").hidden = state.period !== "all";

  const groups = GROUPS.filter(g => state.types.has(g) && PRESENT.includes(g));
  $("legend").replaceChildren(...(groups.length > 1 ? groups.map(g => el("span", {}, key(g), LABEL[g])) : []));

  const box = $("bars"), W = box.clientWidth || 600, H = box.clientHeight || 190;
  const pad = { l: 44, r: 6, t: 8, b: 20 };
  const iw = W - pad.l - pad.r, ih = H - pad.t - pad.b;
  const max = Math.max(...bs.map(b => b.total), 0);
  const ticks = niceTicks(max), top = ticks[ticks.length - 1] || 1;
  const y = v => pad.t + ih - (v / top) * ih;
  const band = iw / bs.length, bw = Math.max(2, Math.min(24, band * 0.72));
  const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": $("bars-title").textContent });

  for (const t of ticks) {
    svg.append(svgEl("line", { class: t ? "grid" : "baseline", x1: pad.l, x2: W - pad.r, y1: y(t), y2: y(t) }));
    const lab = svgEl("text", { x: pad.l - 6, y: y(t) + 4, "text-anchor": "end" }); lab.textContent = compact(t); svg.append(lab);
  }
  if (!max) {
    const t = svgEl("text", { class: "empty", x: pad.l + iw / 2, y: pad.t + ih / 2, "text-anchor": "middle" });
    t.textContent = "No activities in this selection"; svg.append(t);
  }

  const labelEvery = Math.ceil(bs.length / Math.max(1, Math.floor(iw / 44)));
  bs.forEach((b, i) => {
    const cx = pad.l + band * (i + 0.5), x0 = cx - bw / 2;
    const g = svgEl("g", { class: "bar", tabindex: b.total ? 0 : -1 });
    // hit target: the whole band, taller than the mark
    g.append(svgEl("rect", { x: pad.l + band * i, y: pad.t, width: band, height: ih, fill: "transparent" }));
    let base = y(0);
    const stack = groups.filter(gr => b.values[gr] > 0);
    stack.forEach((gr, k) => {
      const h = (b.values[gr] / top) * ih;
      const isTop = k === stack.length - 1;
      const gap = k > 0 ? 2 : 0;                                   // 2px surface gap between segments
      const yTop = base - h, hh = Math.max(0.5, h - gap);
      const r = isTop ? Math.min(4, bw / 2, hh) : 0;               // 4px rounded data-end, square at baseline
      const bottom = yTop + hh;                                     // = base - gap
      const d = `M${x0},${bottom} V${yTop + r} Q${x0},${yTop} ${x0 + r},${yTop}` +
        ` H${x0 + bw - r} Q${x0 + bw},${yTop} ${x0 + bw},${yTop + r} V${bottom} Z`;
      g.append(svgEl("path", { d, fill: colour(gr) }));
      base = yTop;
    });
    const showTooltip = e => showTip(e, b.label,
      stack.slice().reverse().map(gr => ({ colour: colour(gr), label: LABEL[gr], value: `${fmt(b.values[gr], m.digits)} ${m.unit}` })),
      stack.length > 1 ? { label: "Total", value: `${fmt(b.total, m.digits)} ${m.unit}` } :
        (stack.length ? null : { label: "No activities", value: "" }));
    g.addEventListener("pointermove", showTooltip);
    g.addEventListener("pointerleave", hideTip);
    g.addEventListener("focus", () => { const r = g.getBoundingClientRect(); showTooltip({ clientX: r.right, clientY: r.top }); });
    g.addEventListener("blur", hideTip);
    if (b.drill && b.total) {
      const go = () => { hideTip(); state.period = b.drill; update({ fit: true }); };
      g.addEventListener("click", go);
      g.addEventListener("keydown", e => { if (e.key === "Enter") go(); });
    } else g.style.cursor = "default";
    svg.append(g);

    if (i % labelEvery === 0) {
      const t = svgEl("text", { x: cx, y: H - 5, "text-anchor": "middle" }); t.textContent = b.short; svg.append(t);
    }
  });
  box.replaceChildren(svg);

  // table view: every value reachable without hovering
  const table = el("table", {},
    el("thead", {}, el("tr", {}, el("th", {}, per[0].toUpperCase() + per.slice(1)),
      ...groups.map(g => el("th", {}, LABEL[g])), el("th", {}, "Total"))),
    el("tbody", {}, ...bs.filter(b => b.total).map(b => el("tr", {}, el("td", {}, b.label),
      ...groups.map(g => el("td", {}, b.values[g] ? fmt(b.values[g], m.digits) : "")),
      el("td", {}, fmt(b.total, m.digits))))));
  $("bars-table").replaceChildren(table);
}

// ------------------------------------------------------------------ cumulative line

function renderCumulative(acts) {
  const m = METRIC[state.metric];
  $("cum-title").textContent = `Cumulative ${m.label.toLowerCase()}${m.unit ? ` (${m.unit})` : ""} · ${periodLabel()}`;
  const box = $("cumulative"), W = box.clientWidth || 300, H = box.clientHeight || 190;
  const pad = { l: 44, r: 14, t: 10, b: 20 };
  const iw = W - pad.l - pad.r, ih = H - pad.t - pad.b;
  const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": $("cum-title").textContent });

  const pts = [];
  let run = 0;
  for (const a of acts.slice().sort((p, q) => p.date - q.date)) { run += m.get(a); pts.push({ a, t: +a.date, v: run }); }

  let t0, t1;
  if (state.period === "all") { t0 = +ACTS[0].date; t1 = +ACTS[ACTS.length - 1].date; }
  else if (state.period[0] === "Y") { const yy = +state.period.slice(1); t0 = Date.UTC(yy, 0, 1); t1 = Date.UTC(yy + 1, 0, 1); }
  else { const [yy, mo] = state.period.slice(1).split("-").map(Number); t0 = Date.UTC(yy, mo, 1); t1 = Date.UTC(yy, mo + 1, 1); }
  if (t1 <= t0) t1 = t0 + 864e5;

  const ticks = niceTicks(run), top = ticks[ticks.length - 1] || 1;
  const x = t => pad.l + ((t - t0) / (t1 - t0)) * iw;
  const y = v => pad.t + ih - (v / top) * ih;
  for (const t of ticks) {
    svg.append(svgEl("line", { class: t ? "grid" : "baseline", x1: pad.l, x2: W - pad.r, y1: y(t), y2: y(t) }));
    const lab = svgEl("text", { x: pad.l - 6, y: y(t) + 4, "text-anchor": "end" }); lab.textContent = compact(t); svg.append(lab);
  }
  // x labels: start and end of the period
  for (const [t, anchor] of [[t0, "start"], [t1, "end"]]) {
    const d = new Date(t), lab = svgEl("text", { x: x(t), y: H - 5, "text-anchor": anchor });
    lab.textContent = state.period[0] === "M" ? `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}` : `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
    svg.append(lab);
  }

  if (!pts.length) {
    const t = svgEl("text", { class: "empty", x: pad.l + iw / 2, y: pad.t + ih / 2, "text-anchor": "middle" });
    t.textContent = "No activities in this selection"; svg.append(t);
    box.replaceChildren(svg); return;
  }

  // step line: the total jumps at each activity
  let d = `M${x(t0)},${y(0)}`;
  for (const p of pts) d += ` H${x(p.t)} V${y(p.v)}`;
  const tEnd = state.period === "all" ? pts[pts.length - 1].t : Math.min(t1, Date.now());
  d += ` H${x(Math.max(tEnd, pts[pts.length - 1].t))}`;
  const accent = css("--accent");
  svg.append(svgEl("path", { d: d + ` V${y(0)} Z`, fill: accent, "fill-opacity": 0.1, stroke: "none" }));
  svg.append(svgEl("path", { d, fill: "none", stroke: accent, "stroke-width": 2, "stroke-linejoin": "round", "stroke-linecap": "round" }));

  const last = pts[pts.length - 1];
  svg.append(svgEl("circle", { cx: x(Math.max(tEnd, last.t)), cy: y(last.v), r: 4, fill: accent, stroke: css("--surface-1"), "stroke-width": 2 }));
  const endLab = svgEl("text", { x: x(Math.max(tEnd, last.t)) - 6, y: y(last.v) - 8, "text-anchor": "end" });
  endLab.textContent = `${fmt(last.v, m.digits)} ${m.unit}`; endLab.style.fill = css("--text-primary"); endLab.style.fontWeight = 600;
  svg.append(endLab);

  // crosshair snaps to the nearest activity
  const cross = svgEl("line", { class: "crosshair", y1: pad.t, y2: pad.t + ih, visibility: "hidden" });
  const dot = svgEl("circle", { r: 4, fill: accent, stroke: css("--surface-1"), "stroke-width": 2, visibility: "hidden" });
  const hit = svgEl("rect", { x: pad.l, y: pad.t, width: iw, height: ih, fill: "transparent" });
  svg.append(cross, dot, hit);
  hit.addEventListener("pointermove", e => {
    const r = svg.getBoundingClientRect(), px = (e.clientX - r.left) * (W / r.width);
    const t = t0 + ((px - pad.l) / iw) * (t1 - t0);
    let best = pts[0];
    for (const p of pts) if (Math.abs(p.t - t) < Math.abs(best.t - t)) best = p;
    cross.setAttribute("x1", x(best.t)); cross.setAttribute("x2", x(best.t)); cross.setAttribute("visibility", "visible");
    dot.setAttribute("cx", x(best.t)); dot.setAttribute("cy", y(best.v)); dot.setAttribute("visibility", "visible");
    showTip(e, dateLabel(best.a.date), [
      { colour: accent, label: "Cumulative", value: `${fmt(best.v, m.digits)} ${m.unit}` },
      { colour: colour(best.a.group), label: best.a.name, value: `+${fmt(m.get(best.a), state.metric === "km" ? 1 : m.digits)} ${m.unit}` },
    ]);
  });
  hit.addEventListener("pointerleave", () => { hideTip(); cross.setAttribute("visibility", "hidden"); dot.setAttribute("visibility", "hidden"); });
  box.replaceChildren(svg);
}

// ------------------------------------------------------------------ activity lists (one column per person)

const matchesSearch = u => { const q = state.search;
  return !q || u.members.some(a => a.name.toLowerCase().includes(q) || a.type.toLowerCase().includes(q) ||
    LABEL[a.group].toLowerCase().includes(q) || who(a.athlete).toLowerCase() === q); };

const SORTS = {
  "date-desc": (a, b) => b.date - a.date, "date-asc": (a, b) => a.date - b.date,
  "km-desc": (a, b) => (b.km || 0) - (a.km || 0), "time-desc": (a, b) => (b.hours || 0) - (a.hours || 0),
  "name-asc": (a, b) => a.name.localeCompare(b.name),
};

function listColumns() {
  const us = filtered().filter(matchesSearch);
  if (!MULTI) return [{ id: null, acts: us.flatMap(u => u.members) }];
  if (!sharedView()) return [{ id: Number(state.people), acts: us }];
  const acts = us.flatMap(u => u.members);
  return PEOPLE.map(id => ({ id, acts: acts.filter(a => a.athlete === id) }));
}

function listRow(a, sel) {
  const n = mediaOf(a).length;            // a joint outing lists both people's photos
  return el("li", {}, el("button", { "aria-current": String(sel.has(a.id)), onclick: () => select(a.id), title: a.name },
    key(a.group), el("span", { class: "name" }, a.name),
    el("span", { class: "km" }, a.km ? `${fmt(a.km, 1)} km` : ""),
    el("span", { class: "meta" },
      MULTI && a.together ? heart(a.mate) : null,
      `${dateLabel(a.date)}${a.hours ? " · " + hm(a.hours) : ""}${a.onMap ? "" : " · no GPS"}` +
      (n ? ` · ${mediaSummary(a)}` : ""))));
}

function renderList({ reveal = false } = {}) {
  const cols = listColumns(), sel = new Set(selectedActs().map(a => a.id));
  const total = cols.reduce((n, c) => n + c.acts.length, 0);
  $("list-count").textContent = `${fmt(total)} ${total === 1 ? "activity" : "activities"}` +
    (state.search ? ` matching “${state.search}”` : "") + ` · ${periodLabel()}` +
    (MULTI && sharedView() ? " · ♥ = together, click to select both" : "");
  $("cols").classList.toggle("two", cols.length > 1);
  $("cols").replaceChildren(...cols.map(c => {
    const acts = c.acts.slice().sort(SORTS[state.sort]), shown = acts.slice(0, 400);
    const km = acts.reduce((s, a) => s + (a.km || 0), 0);
    return el("div", { class: "col" },
      MULTI ? el("div", { class: "col-head" }, markIcon(c.id), el("b", {}, who(c.id)),
        el("span", { class: "muted small" }, `${fmt(acts.length)} · ${fmt(km)} km`)) : null,
      el("ul", { class: "list" }, ...shown.map(a => listRow(a, sel)),
        acts.length > shown.length ? el("li", { class: "muted small", style: "padding:6px 4px" }, `+${acts.length - shown.length} more – refine the search`) : null));
  }));
  if (reveal) for (const b of $("cols").querySelectorAll('[aria-current="true"]')) {
    const ul = b.closest(".list"), r = b.getBoundingClientRect(), box = ul.getBoundingClientRect();
    if (r.top < box.top || r.bottom > box.bottom) ul.scrollTop += r.top - box.top - box.height / 2 + r.height / 2;
  }
}

// ------------------------------------------------------------------ photos & videos

/* On the published (encrypted) site, vault.js sets window.EXPLORATION_VAULT:
 * media files are encrypted and must be decrypted into blob: URLs. Thumbnails
 * are decrypted only when they scroll into view. Locally, paths are used as is. */
const VAULT = window.EXPLORATION_VAULT || null;
const lazyMedia = VAULT && "IntersectionObserver" in window ? new IntersectionObserver(entries => {
  for (const e of entries) if (e.isIntersecting) {
    lazyMedia.unobserve(e.target);
    VAULT.url(e.target.dataset.vault).then(u => { e.target.src = u; }).catch(() => e.target.classList.add("missing"));
  }
}, { rootMargin: "300px" }) : null;
function setMediaSrc(node, path, { lazy = false } = {}) {
  if (!path) return node;
  if (!VAULT) { node.src = path; return node; }
  if (lazy && lazyMedia) { node.dataset.vault = path; lazyMedia.observe(node); }
  else VAULT.url(path).then(u => { node.src = u; }).catch(() => node.classList.add("missing"));
  return node;
}

function thumbNode(m, onclick, label) {
  const inner = m.kind === "photo"
    ? setMediaSrc(el("img", { alt: label, decoding: "async", ...(VAULT ? {} : { loading: "lazy" }) }), m.thumb, { lazy: true })
    : VAULT ? null      // encrypted videos are only decrypted when played
      : el("video", { src: m.src + "#t=0.5", preload: "metadata", muted: "", playsinline: "", "aria-hidden": "true" });
  return el("button", { class: "thumb", "aria-label": label, onclick }, inner,
            m.kind === "video" ? el("span", { class: "play" }, "▶") : null);
}

/** Outings with photos in the current selection: a joint outing shows both people's media. */
function galleryOutings() {
  const seen = new Set();
  return filtered().filter(matchesSearch).sort((a, b) => b.date - a.date).map(outingOf)
    .filter(o => o.media.length && !seen.has(o) && seen.add(o));
}

function renderGallery() {
  const os = galleryOutings();
  const total = os.reduce((n, o) => n + o.media.length, 0);
  $("media-count").textContent = String(total);
  $("gallery-count").textContent = `${total} photos & videos from ${os.length} ${os.length === 1 ? "outing" : "outings"} · ${periodLabel()}`;
  const seq = os.flatMap(o => o.media.map(m => ({ m, a: o })));
  let k = 0;
  $("gallery").replaceChildren(...os.map(o => el("section", { class: "g-act" },
    el("button", { class: "g-head", onclick: () => select(o.key, { keep: true }) },
      key(o.group), el("span", { class: "name", title: o.name }, MULTI && o.together ? heart() : null, o.name),
      el("span", { class: "meta" }, `${dateLabel(o.date)} · ${o.type}${o.km ? ` · ${fmt(o.km, 1)} km` : ""} · ${mediaSummary(o)}`)),
    el("div", { class: "g-grid" }, ...o.media.map((m, j) => {
      const i = k++;
      return thumbNode(m, () => openLightbox(seq, i), `${o.name}, ${m.kind} ${j + 1}`);
    })))));
}

function setTab(tab) {
  state.tab = tab;
  $("tab-list").setAttribute("aria-selected", tab === "list");
  $("tab-media").setAttribute("aria-selected", tab === "media");
  $("pane-list").hidden = tab !== "list";
  $("pane-media").hidden = tab !== "media";
  $("sort").hidden = tab !== "list";
}
$("tab-list").addEventListener("click", () => setTab("list"));
$("tab-media").addEventListener("click", () => setTab("media"));

// lightbox: a sequence of {m, a: outing}; arrows step through it
const lb = { seq: [], i: 0, opener: null };
function openLightbox(seq, i) {
  lb.seq = seq; lb.i = i; lb.opener = document.activeElement;
  $("lightbox").hidden = false;
  showLightbox();
  $("lb-close").focus();
}
function showLightbox() {
  const { m, a } = lb.seq[lb.i];
  $("lb-media").replaceChildren(m.kind === "photo"
    ? setMediaSrc(el("img", { alt: `${a.name}, photo` }), m.src)
    : setMediaSrc(el("video", { controls: "", autoplay: "", playsinline: "" }), m.src));
  const by = MULTI ? who(BY_ID.get(m.activity_id)?.athlete) : "";
  $("lb-title").textContent = a.name;
  $("lb-meta").textContent = `· ${dateLabel(a.date)} · ${a.type}${a.km ? ` · ${fmt(a.km, 1)} km` : ""}${by ? ` · ${m.kind} by ${by}` : ""}`;
  $("lb-pos").textContent = `${lb.i + 1} / ${lb.seq.length}`;
  $("lb-route").hidden = !a.onMap;
  $("lb-prev").disabled = lb.i === 0;
  $("lb-next").disabled = lb.i === lb.seq.length - 1;
}
function closeLightbox() {
  $("lightbox").hidden = true;
  $("lb-media").replaceChildren();          // stops a playing video
  lb.opener?.focus?.();
}
const stepLightbox = d => { const j = lb.i + d; if (j >= 0 && j < lb.seq.length) { lb.i = j; showLightbox(); } };
$("lb-close").addEventListener("click", closeLightbox);
$("lb-prev").addEventListener("click", () => stepLightbox(-1));
$("lb-next").addEventListener("click", () => stepLightbox(1));
$("lb-route").addEventListener("click", () => { const { a } = lb.seq[lb.i]; closeLightbox(); select(a.key, { keep: true }); });
$("lightbox").addEventListener("click", e => { if (e.target.id === "lightbox" || e.target.tagName === "FIGURE") closeLightbox(); });
addEventListener("keydown", e => {
  if ($("lightbox").hidden) return;
  if (e.key === "Escape") closeLightbox();
  else if (e.key === "ArrowLeft") stepLightbox(-1);
  else if (e.key === "ArrowRight") stepLightbox(1);
});
const openOutingMedia = (o, i = 0) => openLightbox(o.media.map(m => ({ m, a: o })), i);

// ------------------------------------------------------------------ map

const DARK = matchMedia("(prefers-color-scheme: dark)").matches;
const RAMP = DARK ? ["#1c5cab", "#3987e5", "#6da7ec", "#b7d3f6"] : ["#86b6ef", "#3987e5", "#256abf", "#104281"];
const RAMP_LABELS = ["1", "2–4", "5–14", "15+"];
const BASEMAP = `https://tiles.openfreemap.org/styles/${DARK ? "dark" : "positron"}`;
const FALLBACK = { version: 8, sources: {}, layers: [{ id: "bg", type: "background", paint: { "background-color": DARK ? "#1a1a19" : "#e9ecee" } }] };

// ---- base views: Map (OpenFreeMap) · Terrain (+ hillshade) · Satellite, optional 3D relief
const CONFIG = window.EXPLORATION_CONFIG || {};
const SAT_YEAR = 2024;
const SATELLITE = CONFIG.esriApiKey
  ? { // sharp imagery: needs a free ArcGIS developer key (non-commercial, < 1M tiles/month)
      tiles: [`https://ibasemaps-api.arcgis.com/arcgis/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}?token=${encodeURIComponent(CONFIG.esriApiKey)}`],
      maxzoom: 19,
      attribution: 'Powered by <a href="https://www.esri.com" target="_blank">Esri</a> | Esri, Maxar, Earthstar Geographics, and the GIS User Community' }
  : { // free, no key: Sentinel-2 cloudless mosaic, 10 m pixels (blurry at street level)
      tiles: [`https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-${SAT_YEAR}_3857/default/GoogleMapsCompatible/{z}/{y}/{x}.jpg`],
      maxzoom: 15,
      attribution: `<a href="https://cloudless.eox.at" target="_blank">Sentinel-2 cloudless ${SAT_YEAR}</a> by EOX IT Services GmbH ` +
        `(contains modified Copernicus Sentinel data ${SAT_YEAR}), CC BY-NC-SA 4.0` };
const DEM = {   // AWS Open Data terrain tiles (Mapzen "terrarium" encoding), free, no key
  type: "raster-dem", encoding: "terrarium", tileSize: 256, maxzoom: 15,
  tiles: ["https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"],
  attribution: 'Elevation: <a href="https://github.com/tilezen/joerd/blob/master/docs/attribution.md" target="_blank">Terrain Tiles</a> (SRTM, GMTED2010, ETOPO1, EU-DEM and others)' };
const VIEWS = ["map", "terrain", "satellite"];
const store = { get: k => { try { return localStorage.getItem(k); } catch { return null; } },
                set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } } };
state.view = VIEWS.includes(store.get("exploration.view")) ? store.get("exploration.view") : "map";
state.relief3d = store.get("exploration.3d") === "1";
let map = null;

$("media-toggle").addEventListener("change", e => {
  state.showMediaOnMap = e.target.checked;
  if (map?.getLayer("media")) map.setLayoutProperty("media", "visibility", state.showMediaOnMap ? "visible" : "none");
});
if (!MEDIA.length) $("media-toggle-wrap").hidden = true;

$("ramp").replaceChildren(...RAMP.map((c, i) => el("div", {}, el("i", { style: `background:${c};height:${2 + i * 1.5}px` }), RAMP_LABELS[i])));

/* Which units cover a segment. A joint outing counts once; in the Together view
 * it counts only where both recordings passed (a recording without GPS is ignored). */
function unitIndex(us) {
  const idx = new Map();
  for (const u of us) for (const a of u.members) idx.set(a.id, u);
  return idx;
}
function coveringUnits(activityIds, idx) {
  const hits = new Map();
  for (const id of activityIds) {
    const u = idx.get(id);
    if (u) { if (!hits.has(u)) hits.set(u, new Set()); hits.get(u).add(id); }
  }
  const out = [];
  for (const [u, ids] of hits) {
    const need = state.people === "together" ? Math.max(1, u.members.filter(a => a.onMap).length) : 1;
    if (ids.size >= need) out.push(u);
  }
  return out;
}

function networkData(us) {
  const idx = unitIndex(us);
  const features = [];
  for (const f of SEGMENTS) {
    const n = coveringUnits(f.properties.activity_ids, idx).length;
    if (n) features.push({ type: "Feature", geometry: f.geometry, properties: { sid: f.properties.segment_id, n } });
  }
  return { type: "FeatureCollection", features };
}

function placesData(us) {
  const cells = new Map();
  for (const u of us) if (u.onMap && u.cell) {
    const k = u.cell.join(",");
    cells.set(k, (cells.get(k) || 0) + 1);
  }
  return { type: "FeatureCollection", features: [...cells].map(([k, count]) => ({
    type: "Feature", properties: { count }, geometry: { type: "Point", coordinates: k.split(",").map(Number) } })) };
}

function mediaPointsData(us) {
  const seen = new Set(), features = [];
  for (const o of us.map(outingOf)) {
    if (seen.has(o) || !o.mediaAt || !o.media.length) continue;
    seen.add(o);
    features.push({ type: "Feature", properties: { id: o.key, n: o.media.length }, geometry: { type: "Point", coordinates: o.mediaAt } });
  }
  return { type: "FeatureCollection", features };
}

function cameraIcon() {
  // drawn on a canvas: no sprite or font needed (works with the fallback style too)
  const px = 2, s = 26 * px, c = document.createElement("canvas");
  c.width = c.height = s;
  const g = c.getContext("2d");
  g.fillStyle = DARK ? "#ffffff" : "#0b0b0b";
  g.strokeStyle = DARK ? "#1a1a19" : "#ffffff"; g.lineWidth = 2 * px;
  g.beginPath(); g.arc(s / 2, s / 2, s / 2 - px * 1.5, 0, 2 * Math.PI); g.fill(); g.stroke();
  g.fillStyle = DARK ? "#0b0b0b" : "#ffffff";
  const w = 13 * px, h = 9 * px, x = (s - w) / 2, y = (s - h) / 2 + px;
  g.beginPath(); g.roundRect(x, y, w, h, 2 * px); g.fill();
  g.fillRect(s / 2 - 3 * px, y - 2 * px, 6 * px, 2.5 * px);
  g.fillStyle = DARK ? "#ffffff" : "#0b0b0b";
  g.beginPath(); g.arc(s / 2, y + h / 2, 2.6 * px, 0, 2 * Math.PI); g.fill();
  return { image: g.getImageData(0, 0, s, s), pixelRatio: px };
}

function highlightData() {
  const ids = new Set(selectedActs().map(a => a.id));
  return { type: "FeatureCollection",
           features: ids.size ? SEGMENTS.filter(f => f.properties.activity_ids.some(id => ids.has(id))) : [] };
}

function fitTo(features, opts = {}) {
  if (!map || !features.length) return;
  const b = new maplibregl.LngLatBounds();
  for (const f of features) {
    const c = f.geometry.coordinates;
    if (f.geometry.type === "Point") b.extend(c); else for (const p of c) b.extend(p);
  }
  map.fitBounds(b, { padding: 50, maxZoom: 15, duration: 600, ...opts });
}

function addBaseViews() {
  // Satellite covers the whole basemap; hillshade sits under roads and labels.
  const layers = map.getStyle().layers;
  const firstRoadOrLabel = layers.find(l => l.type === "symbol" || l["source-layer"] === "transportation")?.id;
  map.addSource("satellite", { type: "raster", tileSize: 256, ...SATELLITE });
  map.addLayer({ id: "satellite", type: "raster", source: "satellite",
                 layout: { visibility: "none" }, paint: { "raster-fade-duration": 150 } });
  map.addSource("dem-shade", DEM);
  map.addSource("dem-3d", DEM);                    // separate source for 3D, as MapLibre recommends
  map.addLayer({ id: "hillshade", type: "hillshade", source: "dem-shade", layout: { visibility: "none" },
    paint: { "hillshade-exaggeration": 0.55,
             "hillshade-shadow-color": DARK ? "#000000" : "#5a6470",
             "hillshade-highlight-color": DARK ? "#6b6b66" : "#ffffff",
             "hillshade-accent-color": DARK ? "#1a1a19" : "#8a8f96" } }, firstRoadOrLabel);
  applyView();
}

function applyView() {
  if (!map?.getLayer("satellite")) return;
  map.setLayoutProperty("satellite", "visibility", state.view === "satellite" ? "visible" : "none");
  map.setLayoutProperty("hillshade", "visibility", state.view === "terrain" ? "visible" : "none");
  const on3d = state.relief3d && state.view !== "map";
  map.setTerrain(on3d ? { source: "dem-3d", exaggeration: 1.4 } : null);
  if (on3d && map.getPitch() < 30) map.easeTo({ pitch: 60, duration: 800 });
  if (!on3d && map.getPitch() > 0) map.easeTo({ pitch: 0, bearing: 0, duration: 600 });
  document.querySelectorAll("#views button").forEach(b => b.setAttribute("aria-pressed", b.dataset.v === state.view));
  const b3 = $("relief3d");
  b3.setAttribute("aria-pressed", on3d);
  b3.disabled = state.view === "map";
  b3.title = state.view === "map" ? "3D relief is available in the Terrain and Satellite views" : "Tilt the map and show the relief in 3D";
}

$("views").addEventListener("click", e => {
  const b = e.target.closest("button"); if (!b) return;
  state.view = b.dataset.v; store.set("exploration.view", state.view); applyView();
});
$("relief3d").addEventListener("click", () => {
  state.relief3d = !(state.relief3d && state.view !== "map");
  store.set("exploration.3d", state.relief3d ? "1" : "0"); applyView();
});

function initMap(style) {
  map = new maplibregl.Map({
    container: "map", style, center: [4.35, 50.85], zoom: 4,
    attributionControl: { compact: true, customAttribution:
      '<a href="https://openfreemap.org" target="_blank">OpenFreeMap</a> © <a href="https://www.openmaptiles.org/" target="_blank">OpenMapTiles</a> Data from <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap</a>' },
  });
  map.addControl(new maplibregl.NavigationControl({ showCompass: true, visualizePitch: true }), "top-right");

  map.on("load", () => {
    const us = filtered();
    map.addSource("places", { type: "geojson", data: placesData(us) });
    map.addSource("net", { type: "geojson", data: networkData(us), tolerance: 0 });
    map.addSource("hl", { type: "geojson", data: highlightData(), tolerance: 0 });
    map.addSource("media", { type: "geojson", data: mediaPointsData(us) });

    const step = ["step", ["get", "n"], RAMP[0], 2, RAMP[1], 5, RAMP[2], 15, RAMP[3]];
    const width = extra => ["interpolate", ["linear"], ["zoom"],
      3, ["step", ["get", "n"], 1.2 + extra, 5, 2 + extra],
      13, ["step", ["get", "n"], 2.2 + extra, 2, 3 + extra, 5, 4.5 + extra, 15, 6 + extra]];

    addBaseViews();

    map.addLayer({ id: "places", type: "circle", source: "places", maxzoom: 9, paint: {
      "circle-radius": ["interpolate", ["linear"], ["sqrt", ["get", "count"]], 1, 5, 10, 18],
      "circle-color": RAMP[1], "circle-opacity": 0.55,
      "circle-stroke-color": DARK ? "#1a1a19" : "#ffffff", "circle-stroke-width": 1.5 } });
    map.addLayer({ id: "net-casing", type: "line", source: "net", layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": DARK ? "#1a1a19" : "#ffffff", "line-opacity": 0.7, "line-width": width(2) } });
    map.addLayer({ id: "net", type: "line", source: "net", layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": step, "line-width": width(0) } });
    map.addLayer({ id: "hl-casing", type: "line", source: "hl", layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": DARK ? "#1a1a19" : "#ffffff", "line-width": 9 } });
    map.addLayer({ id: "hl", type: "line", source: "hl", layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": DARK ? "#ffffff" : "#0b0b0b", "line-width": 4 } });

    const cam = cameraIcon();
    map.addImage("camera", cam.image, { pixelRatio: cam.pixelRatio });
    map.addLayer({ id: "media", type: "symbol", source: "media", minzoom: 7,
      layout: { "icon-image": "camera", "icon-allow-overlap": true, "icon-size": ["interpolate", ["linear"], ["zoom"], 7, 0.75, 13, 1],
                visibility: state.showMediaOnMap ? "visible" : "none" } });
    map.on("mouseenter", "media", () => { map.getCanvas().style.cursor = "pointer"; });
    map.on("mouseleave", "media", () => { map.getCanvas().style.cursor = ""; });
    map.on("click", "media", e => {
      e.preventDefault();
      const a = BY_ID.get(e.features[0].properties.id);
      if (a) openOutingMedia(a.outing);
    });

    fitTo(SEGMENTS, { duration: 0 });

    map.on("mouseenter", "net", () => { map.getCanvas().style.cursor = "pointer"; });
    map.on("mouseleave", "net", () => { map.getCanvas().style.cursor = ""; });
    map.on("click", "net", e => { if (!e.defaultPrevented) segmentPopup(e.lngLat, e.features[0].properties.sid); });
  });
}

function segmentPopup(lngLat, sid) {
  const props = SEG_BY_ID.get(sid).properties;
  const inF = coveringUnits(props.activity_ids, unitIndex(filtered())).sort((a, b) => b.date - a.date);
  const everyone = new Set(props.activity_ids.map(id => BY_ID.get(id)?.outing).filter(Boolean)).size;
  const counts = PRESENT.map(g => [g, inF.filter(a => a.group === g).length]).filter(([, n]) => n);
  const node = el("div", { class: "pop" },
    el("h3", {}, `${inF.length} ${inF.length === 1 ? "activity" : "activities"}${viewLabel() ? " · " + viewLabel() : ""}`),
    el("div", { class: "meta" }, counts.map(([g, n]) => `${LABEL[g]} ${n}`).join(" · ") +
      ` · segment ${Math.round(props.length_m)} m` + (everyone > inF.length ? ` · ${everyone - inF.length} more outside the filter` : "")),
    el("ul", {}, ...inF.map(u => el("li", {}, el("button", { onclick: () => select(u.key) },
      MULTI && u.together ? heart() : null, u.name, el("br"),
      el("small", {}, `${dateLabel(u.date)} · ${u.type}${u.km ? ` · ${fmt(u.km, 1)} km` : ""}` +
        (MULTI && !u.together && u.members[0].athlete != null ? ` · ${who(u.members[0].athlete)}` : "")))))));
  new maplibregl.Popup({ maxWidth: "300px" }).setLngLat(lngLat).setDOMContent(node).addTo(map);
}

// ------------------------------------------------------------------ selection

function renderCard() {
  const acts = selectedActs(), card = $("selected");
  if (!acts.length) { card.hidden = true; return; }
  const o = acts[0].outing;
  const metrics = a => [
    ["Distance", a.km ? `${fmt(a.km, 2)} km` : "–"],
    ["Moving time", hm(a.hours)],
    ["Elapsed time", hm(a.elapsedH)],
    ["Elevation gain", a.elev != null ? `${fmt(a.elev)} m` : "–"],
    [onFoot(a) ? "Pace" : "Avg speed", speedText(a)],
  ];
  let body;
  if (acts.length === 1) {
    const a = acts[0];
    body = el("dl", {}, ...[["Date", dateLabel(a.date)], ["Type", a.type], ...(MULTI ? [["Recorded by", who(a.athlete)]] : []), ...metrics(a)]
      .flatMap(([k, v]) => [el("dt", {}, k), el("dd", {}, v)]));
  } else {
    const cols = acts.map(metrics);
    body = el("table", { class: "duo" },
      el("thead", {}, el("tr", {}, el("th", {}), ...acts.map(a => el("th", {}, markIcon(a.athlete), " ", who(a.athlete))))),
      el("tbody", {}, ...cols[0].map(([k], i) => el("tr", {}, el("th", {}, k), ...cols.map(c => el("td", {}, c[i][1]))))));
  }
  const otherNames = acts.slice(1).filter(a => a.name !== o.name);
  card.replaceChildren(...[
    el("button", { class: "close", "aria-label": "Close", onclick: () => select(state.selected) }, "×"),
    el("h3", {}, MULTI && o.together ? heart() : null, o.name),
    ...otherNames.map(a => el("div", { class: "muted small" }, `${who(a.athlete)}: ${a.name}`)),
    el("div", { class: "muted small" },
      (acts.length > 1 ? `${dateLabel(o.date)} · ${o.type} · ${TOGETHER_LABEL} · ` : "") +
      (o.onMap ? "highlighted on the map" : "no GPS track")),
    body,
    o.media.length ? el("div", { class: "strip" }, ...o.media.slice(0, 10).map((m, i) =>
      thumbNode(m, () => openOutingMedia(o, i), `${o.name}, ${m.kind} ${i + 1}`))) : null,
  ].filter(Boolean));
  card.hidden = false;
}

function select(id, { keep = false } = {}) {
  const same = state.selected != null && BY_ID.get(state.selected)?.outing === BY_ID.get(id)?.outing;
  state.selected = same && !keep ? null : id;
  renderCard();
  if (map?.getSource("hl")) {
    const hl = highlightData();
    map.getSource("hl").setData(hl);
    if (hl.features.length) fitTo(hl.features);
  }
  renderList({ reveal: true });
  if (HAS_PLAN) renderPlan();
}

// ------------------------------------------------------------------ training plan

const PLAN_PEOPLE = MULTI ? PEOPLE.filter(id => TRAIN.some(a => a.athlete === id) || RACES.some(a => a.athlete === id)) : [null];

function nextRaceDays() {
  const next = T.next_race;
  if (!next?.date) return null;
  const t = new Date(), today = Date.UTC(t.getFullYear(), t.getMonth(), t.getDate());   // calendar days
  const days = Math.round((Date.parse(next.date + "T00:00:00Z") - today) / 864e5);
  return days >= 0 ? days : null;
}

function renderTrainingHead() {
  const first = [...TRAIN, ...RACES][0];
  const weeks = TRAIN.length ? Math.max(...TRAIN.map(a => a.train[0])) : 0;
  $("tr-title").textContent = T.title || "Training plan";
  // one-line summary in the collapsed banner
  const outs = new Set(TRAIN.map(a => a.outing));
  const km = [...outs].reduce((s, o) => s + (o.km || 0), 0);
  const race = RACES.length ? RACES.reduce((m, a) => a.date > m.date ? a : m) : null;
  const best = race ? race.outing.members.filter(a => a.race).reduce((m, a) => (a.elapsedH ?? Infinity) < (m.elapsedH ?? Infinity) ? a : m) : null;
  const days = nextRaceDays();
  const part = (v, t) => [el("b", {}, v), ` ${t}`];
  const parts = [part(fmt(outs.size), "runs"), part(fmt(km), "km"), weeks ? part(fmt(weeks), "weeks") : null,
    best ? part(hms(best.elapsedH ?? best.hours), `at the race of ${MONTHS[race.date.getUTCMonth()]} ${race.year}`) : null,
    days != null ? part(fmt(days), `days to ${T.next_race.name || "the next race"}${T.next_race.confirmed ? "" : " (date tbc)"}`) : null].filter(Boolean);
  $("tr-summary").replaceChildren(...parts.flatMap((p, i) => i ? [" · ", ...p] : p));
  $("tr-sub").textContent = `${first ? "Since " + dateLabel(first.date) : ""}${weeks ? ` · ${weeks} weeks` : ""} · runs named “W<week>.<run>”`;
  $("tr-legend").replaceChildren(
    ...(MULTI ? PLAN_PEOPLE.map(id => el("span", {}, markIcon(id), who(id))) : []),
    el("span", {}, el("i", { class: "goal-key" }), `${fmt(GOAL)} km`),
    RACES.length ? el("span", {}, el("i", { class: "race-key" }), "Race") : null);
}

function renderTrainingTiles() {
  const outs = [...new Set(TRAIN.map(a => a.outing))];
  const km = outs.reduce((s, o) => s + (o.km || 0), 0);
  const weeks = TRAIN.length ? Math.max(...TRAIN.map(a => a.train[0])) : 0;
  const perPerson = f => PLAN_PEOPLE.map(id => `${who(id)} ${f(TRAIN.filter(a => a.athlete === id))}`).join(" · ");
  const longest = TRAIN.reduce((m, a) => (a.km || 0) > (m?.km || 0) ? a : m, null);
  const tiles = [
    tile("Training runs", fmt(outs.length), "",
      `W1 → W${weeks}` + (MULTI ? ` · ${fmt(outs.filter(o => o.together).length)} together` : "")),
    tile("Distance", fmt(km), "km", MULTI ? perPerson(as => `${fmt(as.reduce((s, a) => s + (a.km || 0), 0))} km`) : `${fmt(km / Math.max(1, weeks), 1)} km per week`,
      MULTI ? "A run done together counts once, with the average of the two recordings" : null),
    tile("Longest training run", longest ? fmt(longest.km, 1) : "–", "km",
      longest ? `W${longest.train.join(".")} · ${dateLabel(longest.date)}${MULTI ? " · " + who(longest.athlete) : ""}` : ""),
  ];
  const raceOutings = [...new Set(RACES.map(a => a.outing))].sort((a, b) => b.date - a.date);
  for (const o of raceOutings.slice(0, 2)) {
    const best = o.members.filter(a => a.race).reduce((m, a) => (a.elapsedH ?? Infinity) < (m.elapsedH ?? Infinity) ? a : m);
    tiles.push(tile(`Race · ${dateLabel(o.date)}`, hms(best.elapsedH ?? best.hours), "",
      (MULTI ? o.members.map(a => `${who(a.athlete)} ${hms(a.elapsedH ?? a.hours)}`).join(" · ") + " · " : "") +
      `${fmt(o.km, 1)} km · ${mmss(paceOf(best, best.elapsedH ?? best.hours))} /km`, `${o.name} (elapsed time)`));
  }
  const next = T.next_race, days = nextRaceDays();
  if (days != null) {
    tiles.push(tile(next.name || "Next race", fmt(days), days === 1 ? "day" : "days",
      `${dateLabel(new Date(next.date + "T00:00:00Z"))}${next.confirmed ? "" : " · date not confirmed yet"} · ${fmt(days / 7, 0)} weeks`));
  }
  $("tr-tiles").replaceChildren(...tiles);
}

function planCellTip(e, label, acts) {
  showTip(e, label, acts.map(a => ({
    icon: MULTI ? markIcon(a.athlete) : el("i"),
    label: `${MULTI ? who(a.athlete) + " · " : ""}${dateLabel(a.date)}`,
    value: `${a.km ? fmt(a.km, 1) + " km" : "–"}${paceOf(a) ? " · " + mmss(paceOf(a)) + " /km" : ""}`,
  })));
}

function planMarks(acts) {
  const n = Math.max(PLAN_PEOPLE.length, 1), s = svgEl("svg", { width: 8 + n * 11, height: 14, "aria-hidden": "true" });
  PLAN_PEOPLE.forEach((id, i) => {
    const a = acts.find(x => x.athlete === id || id == null);
    if (a) s.append(personMark(a.athlete, 6.5 + i * 11, 7, 4.5));
  });
  if (acts.length > 1 && acts.every(a => a.together && a.outing === acts[0].outing))
    s.prepend(svgEl("line", { x1: 6.5, x2: 6.5 + (n - 1) * 11, y1: 7, y2: 7, stroke: css("--accent"), "stroke-width": 2 }));
  return s;
}

function renderPlan() {
  if (!HAS_PLAN) return;
  const cells = new Map();                                 // "w.r" -> activities (first per person)
  for (const a of TRAIN) {
    const k = a.train.join(".");
    if (!cells.has(k)) cells.set(k, []);
    if (!cells.get(k).some(b => b.athlete === a.athlete)) cells.get(k).push(a);
  }
  const weeks = TRAIN.length ? Math.max(...TRAIN.map(a => a.train[0])) : 0;
  const runs = TRAIN.length ? Math.max(...TRAIN.map(a => a.train[1])) : 1;
  const weekStart = w => Math.min(...TRAIN.filter(a => a.train[0] === w).map(a => +a.date));
  // the race sits after the last week that started before it
  const race = RACES.length ? RACES.reduce((m, a) => a.date > m.date ? a : m) : null;
  const races = race ? RACES.filter(a => a.outing === race.outing || Math.abs(a.date - race.date) < 864e5) : [];
  let raceAfter = null;
  if (race) for (let w = 1; w <= weeks; w++) if (weekStart(w) < +race.date) raceAfter = w;
  const sel = new Set(selectedActs().map(a => a.id));

  const cellButton = (label, acts) => {
    const b = el("button", { class: "pc", "aria-current": String(acts.some(a => sel.has(a.id))),
      "aria-label": `${label}: ` + acts.map(a => `${MULTI ? who(a.athlete) + " " : ""}${a.km ? fmt(a.km, 1) + " km" : ""}`).join(", "),
      onclick: () => { hideTip(); select(acts[0].id, { keep: true }); $("map").scrollIntoView({ behavior: "smooth", block: "center" }); },
      onpointermove: e => planCellTip(e, label, acts), onpointerleave: hideTip }, planMarks(acts));
    return b;
  };

  const head = el("tr", {}, el("th", { class: "rh" }, "Run"));
  for (let w = 1; w <= weeks; w++) {
    head.append(el("th", {}, `W${w}`));
    if (raceAfter === w) head.append(el("th", { class: "race" }, "Race"));
  }
  if (race && raceAfter == null) head.insertBefore(el("th", { class: "race" }, "Race"), head.children[1]);
  const body = [];
  for (let r = 1; r <= runs; r++) {
    const tr = el("tr", {}, el("th", { class: "rh" }, String(r)));
    const raceCell = () => r === 1 ? el("td", { class: "race", rowspan: runs }, cellButton(race.name, races)) : null;
    if (race && raceAfter == null) tr.append(raceCell());
    for (let w = 1; w <= weeks; w++) {
      const acts = cells.get(`${w}.${r}`);
      tr.append(acts ? el("td", {}, cellButton(`W${w}.${r}`, acts)) : el("td", { class: "none" }));
      if (raceAfter === w) { const c = raceCell(); if (c) tr.append(c); }
    }
    body.push(tr);
  }
  $("tr-plan").replaceChildren(el("table", { class: "plan" }, el("thead", {}, head), el("tbody", {}, ...body)));
}

/** Dot chart over time: one mark per person and run, joint runs linked. */
function trainingChart(boxId, { value, label, invert = false, goal = null, yFmt = v => fmt(v) }) {
  const box = $(boxId), W = box.clientWidth || 500, H = box.clientHeight || 200;
  const pad = { l: 40, r: 12, t: 10, b: 20 };
  const iw = W - pad.l - pad.r, ih = H - pad.t - pad.b;
  const acts = [...TRAIN, ...RACES.filter(a => !a.train)].filter(a => value(a) != null);
  const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": label });
  if (!acts.length) { box.replaceChildren(svg); return; }

  const t0 = Math.min(...acts.map(a => +a.date)) - 4 * 864e5, t1 = Math.max(...acts.map(a => +a.date)) + 4 * 864e5;
  const vs = acts.map(value);
  let lo, hi, ticks;
  if (invert) {                                                     // pace: faster at the top
    lo = Math.floor(Math.min(...vs) * 2) / 2; hi = Math.ceil(Math.max(...vs) * 2) / 2;
    if (hi - lo < 1) hi = lo + 1;
    const stepV = hi - lo > 3 ? 1 : 0.5;
    ticks = []; for (let v = lo; v <= hi + 1e-9; v += stepV) ticks.push(v);
  } else {
    ticks = niceTicks(Math.max(...vs, goal ? goal * 1.08 : 0)); lo = 0; hi = ticks[ticks.length - 1] || 1;
  }
  const x = t => pad.l + ((t - t0) / (t1 - t0)) * iw;
  const y = v => invert ? pad.t + ((v - lo) / (hi - lo)) * ih : pad.t + ih - ((v - lo) / (hi - lo)) * ih;

  for (const t of ticks) {
    svg.append(svgEl("line", { class: t === lo && !invert ? "baseline" : "grid", x1: pad.l, x2: W - pad.r, y1: y(t), y2: y(t) }));
    const lab = svgEl("text", { x: pad.l - 6, y: y(t) + 4, "text-anchor": "end" }); lab.textContent = yFmt(t); svg.append(lab);
  }
  // month labels
  const d0 = new Date(t0), months = [];
  for (let m = Date.UTC(d0.getUTCFullYear(), d0.getUTCMonth() + 1, 1); m < t1; m = Date.UTC(new Date(m).getUTCFullYear(), new Date(m).getUTCMonth() + 1, 1)) months.push(m);
  const every = Math.ceil(months.length / Math.max(1, Math.floor(iw / 40)));
  months.forEach((m, i) => {
    if (i % every) return;
    const d = new Date(m), lab = svgEl("text", { x: x(m), y: H - 5, "text-anchor": "middle" });
    lab.textContent = d.getUTCMonth() === 0 || i === 0 ? `${MONTHS[d.getUTCMonth()]} ${String(d.getUTCFullYear()).slice(2)}` : MONTHS[d.getUTCMonth()];
    svg.append(lab);
  });
  // goal and race markers
  if (goal) {
    svg.append(svgEl("line", { class: "goal", x1: pad.l, x2: W - pad.r, y1: y(goal), y2: y(goal) }));
    const g = svgEl("text", { x: pad.l + 4, y: y(goal) - 4, class: "goal-label" }); g.textContent = `${fmt(goal)} km goal`; svg.append(g);
  }
  for (const o of new Set(RACES.map(a => a.outing))) {
    svg.append(svgEl("line", { class: "race", x1: x(+o.date), x2: x(+o.date), y1: pad.t, y2: pad.t + ih }));
    const r = svgEl("text", { x: x(+o.date) + 4, y: pad.t + 10, class: "race-label" }); r.textContent = "Race"; svg.append(r);
  }
  // joint runs: a thin link between the two marks
  for (const o of new Set(acts.filter(a => a.together).map(a => a.outing))) {
    const ms = o.members.filter(a => value(a) != null && acts.includes(a));
    if (ms.length > 1) svg.append(svgEl("line", { class: "pair", x1: x(+ms[0].date), x2: x(+ms[1].date), y1: y(value(ms[0])), y2: y(value(ms[1])) }));
  }
  const sel = new Set(selectedActs().map(a => a.id));
  const pts = acts.map(a => ({ a, px: x(+a.date), py: y(value(a)) }));
  for (const p of pts.slice().sort((p, q) => rank(q.a.athlete) - rank(p.a.athlete)))
    svg.append(personMark(p.a.athlete, p.px, p.py, p.a.race ? 6 : sel.has(p.a.id) ? 5.5 : 4));

  const ring = svgEl("circle", { r: 8, fill: "none", stroke: css("--text-primary"), "stroke-width": 1.5, visibility: "hidden" });
  const hit = svgEl("rect", { x: pad.l, y: pad.t, width: iw, height: ih, fill: "transparent", style: "cursor:pointer" });
  svg.append(ring, hit);
  let near = null;
  hit.addEventListener("pointermove", e => {
    const r = svg.getBoundingClientRect(), px = (e.clientX - r.left) * (W / r.width), py = (e.clientY - r.top) * (H / r.height);
    near = pts.reduce((m, p) => Math.hypot(p.px - px, p.py - py) < Math.hypot(m.px - px, m.py - py) ? p : m);
    ring.setAttribute("cx", near.px); ring.setAttribute("cy", near.py); ring.setAttribute("visibility", "visible");
    const ms = near.a.outing.members.filter(a => a.train || a.race);
    showTip(e, `${near.a.train ? "W" + near.a.train.join(".") : near.a.name} · ${dateLabel(near.a.date)}`, ms.map(a => ({
      icon: MULTI ? markIcon(a.athlete) : el("i"), label: MULTI ? who(a.athlete) : label,
      value: `${a.km ? fmt(a.km, 1) + " km" : "–"}${paceOf(a) ? " · " + mmss(paceOf(a)) + " /km" : ""}` })));
  });
  hit.addEventListener("pointerleave", () => { hideTip(); ring.setAttribute("visibility", "hidden"); near = null; });
  hit.addEventListener("click", () => { if (near) { hideTip(); select(near.a.id, { keep: true }); $("map").scrollIntoView({ behavior: "smooth", block: "center" }); } });
  box.replaceChildren(svg);
}

function renderTrainingCharts() {
  trainingChart("tr-dist", { value: a => a.km, label: "Distance per run (km)", goal: GOAL });
  trainingChart("tr-pace", { value: a => { const p = paceOf(a); return p && p > 2.5 && p < 12 ? p : null; },
                             label: "Pace (min/km)", invert: true, yFmt: mmss });
}

function renderTraining() {
  $("training").hidden = !HAS_PLAN;
  if (!HAS_PLAN) return;
  renderTrainingHead();
  renderTrainingTiles();
  renderPlan();
  if (state.trainingOpen) renderTrainingCharts();
}

/** The section is a thin banner until opened (banner click or the "20 km plan" chip). */
function setTrainingOpen(open) {
  state.trainingOpen = open;
  $("tr-body").hidden = !open;
  $("tr-toggle").setAttribute("aria-expanded", String(open));
  $("tr-toggle").title = open ? "Collapse" : "Show the plan, the race and the progression charts";
  if (open) renderTrainingCharts();              // charts need the visible width
}
$("tr-toggle").addEventListener("click", () => setTrainingOpen(!state.trainingOpen));

// ------------------------------------------------------------------ update

function update({ fit = false } = {}) {
  const us = filtered();
  buildFilters();
  renderTiles(us);
  renderBars(us);
  renderCumulative(us);
  renderList();
  renderGallery();
  $("map-note").textContent = !MULTI ? "" : state.people === "together" ? "Only paths you both covered on the same outing"
    : state.people === "all" ? "An outing done together counts once" : "";
  if (map?.getSource("net")) {
    const net = networkData(us);
    map.getSource("net").setData(net);
    map.getSource("places").setData(placesData(us));
    map.getSource("media").setData(mediaPointsData(us));
    if (fit) fitTo(net.features);
  }
}

// ------------------------------------------------------------------ start

const first = ACTS[0]?.date, last = ACTS[ACTS.length - 1]?.date;
const span = `${first ? MONTHS[first.getUTCMonth()] + " " + first.getUTCFullYear() : ""} → ${last ? MONTHS[last.getUTCMonth()] + " " + last.getUTCFullYear() : ""}`;
$("subtitle").textContent = MULTI
  ? `${PEOPLE.map(id => `${who(id)} ${fmt(ACTS.filter(a => a.athlete === id).length)}`).join(" · ")} activities · ` +
    `${fmt(OUTINGS.filter(o => o.together).length)} together · ${span} · ${fmt(SEGMENTS.length)} path segments`
  : `${fmt(ACTS.length)} activities · ${span} · ${fmt(SEGMENTS.length)} path segments`;
$("footer").textContent = `Data generated ${D.generated}. Basemap © OpenFreeMap · OpenMapTiles · OpenStreetMap contributors.`;
document.querySelector(".explore").classList.toggle("multi", MULTI);

update();
renderTraining();
let resizeTimer = null;
addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { renderBars(filtered()); renderCumulative(filtered()); if (HAS_PLAN && state.trainingOpen) renderTrainingCharts(); }, 100);
});

// Basemap: free OpenFreeMap vector tiles; plain background if unreachable.
fetch(BASEMAP).then(r => r.ok ? BASEMAP : FALLBACK).catch(() => FALLBACK).then(initMap);
