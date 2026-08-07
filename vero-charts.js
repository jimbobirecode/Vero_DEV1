/* Vero charts — Tremor's chart vocabulary, without Tremor.
 *
 * Tremor is React + Recharts + Tailwind. This dashboard is one static HTML file
 * of vanilla JS with no build step, and a CSP of script-src 'self' that blocks
 * CDN loads — so the library itself cannot come in. What can come in is the part
 * that actually matters: gridlines, real axes, a crosshair that snaps to the
 * nearest point, one tooltip listing every series, legends, direct labels,
 * entry animation, empty states, and a table view for anyone who cannot use a
 * chart at all.
 *
 * Served from the same origin as a plain <script src>, so nothing about the CSP
 * or the deploy changes.
 *
 * ---------------------------------------------------------------------------
 * Colour
 *
 * The five brand colours are deliberately muted, which is right for a UI and
 * wrong for data: run through the six checks, forest is too dark and too close
 * to gray to work as a series colour at all. The steps below hold each brand
 * hue and lift it into the passing lightness/chroma band — the same move the
 * design system already makes for --brass-light. They are validated, not
 * eyeballed: all six checks pass, worst adjacent pair ΔE 10.0 under protanopia
 * and 16.8 for normal vision.
 *
 * Most charts here need no categorical palette at all. Trends is small
 * multiples — one series per chart — and magnitude charts are sequential. The
 * three-hue set exists for the rare chart that genuinely plots distinct series,
 * and stops at three on purpose.
 * ---------------------------------------------------------------------------
 */
(function (global) {
  "use strict";

  const NS = "http://www.w3.org/2000/svg";

  const PALETTE = {
    // Fixed order, never cycled. A fourth series folds into "Other" or facets.
    categorical: ["#009C85", "#B78733", "#9C4A34"],
    // Reserved. Never reused as "series 4", and always shipped with a label.
    status: { good: "#267B47", warning: "#BA8535", critical: "#9C4A34", neutral: "#5B6259" },
    // One hue, light to dark, for magnitude.
    sequential: ["#B2E6DD", "#7ACFC1", "#41B8A5", "#009C85", "#00705F"],
    // Chrome. One step off the surface, never competing with the data.
    grid: "#E4DFD1",
    axis: "#5B6259",
    ink: "#20241F",
    inkSoft: "#5B6259",
    surface: "#FFFFFF",
    deemphasis: "#C9D2CA",
  };

  // ---------------------------------------------------------------- maths --
  // Pure, and exported, so the parts that decide where a pixel goes can be
  // tested without a browser.

  // Axis ticks on round numbers. A tick at 3.7143 tells the reader nothing;
  // these carry the values that are not directly labelled, so they have to be
  // values a person can hold in their head.
  function niceTicks(min, max, count) {
    count = count || 5;
    if (!(isFinite(min) && isFinite(max))) return [];
    if (min === max) return [min];
    const span = niceNum(max - min, false);
    const step = niceNum(span / (count - 1), true);
    const lo = Math.floor(min / step) * step;
    const hi = Math.ceil(max / step) * step;
    const out = [];
    // Accumulate in integer multiples rather than by repeated addition, which
    // drifts and produces ticks like 0.30000000000000004.
    for (let i = 0; lo + i * step <= hi + step * 1e-9; i++) {
      out.push(round(lo + i * step, 10));
    }
    return out;
  }

  function niceNum(range, round_) {
    const exp = Math.floor(Math.log10(range));
    const frac = range / Math.pow(10, exp);
    let nf;
    if (round_) nf = frac < 1.5 ? 1 : frac < 3 ? 2 : frac < 7 ? 5 : 10;
    else nf = frac <= 1 ? 1 : frac <= 2 ? 2 : frac <= 5 ? 5 : 10;
    return nf * Math.pow(10, exp);
  }

  function round(n, dp) {
    const f = Math.pow(10, dp);
    return Math.round(n * f) / f;
  }

  // A value's position along an axis. Guards the degenerate case where every
  // value is identical, which otherwise divides by zero and paints nothing.
  function scale(value, domain, range) {
    const [d0, d1] = domain, [r0, r1] = range;
    if (d1 === d0) return (r0 + r1) / 2;
    return r0 + ((value - d0) / (d1 - d0)) * (r1 - r0);
  }

  // The domain for a set of series. Padded so a line never touches the frame,
  // and anchored at zero for bars because a truncated bar axis lies about
  // proportion — the one axis rule people break most often.
  function domainOf(values, { zeroBased = false, pad = 0.08 } = {}) {
    const nums = values.filter((v) => typeof v === "number" && isFinite(v));
    if (!nums.length) return [0, 1];
    let lo = Math.min(...nums), hi = Math.max(...nums);
    if (zeroBased) lo = Math.min(0, lo);
    if (lo === hi) { lo = zeroBased ? 0 : lo - 1; hi = hi + 1; }
    const span = hi - lo;
    return [zeroBased ? lo : lo - span * pad, hi + span * pad];
  }

  // Big numbers, short. 1284 -> 1,284 · 12900 -> 12.9K
  function compact(n) {
    if (n == null || !isFinite(n)) return "—";
    const abs = Math.abs(n);
    if (abs >= 1e9) return round(n / 1e9, 1) + "B";
    if (abs >= 1e6) return round(n / 1e6, 1) + "M";
    if (abs >= 1e4) return round(n / 1e3, 1) + "K";
    return Number(round(n, 2)).toLocaleString();
  }

  function linePath(points) {
    return points.map((p, i) => (i ? "L" : "M") + round(p[0], 2) + " " + round(p[1], 2)).join(" ");
  }

  function areaPath(points, baselineY) {
    if (!points.length) return "";
    const first = points[0], last = points[points.length - 1];
    return linePath(points) +
      " L" + round(last[0], 2) + " " + round(baselineY, 2) +
      " L" + round(first[0], 2) + " " + round(baselineY, 2) + " Z";
  }

  // ------------------------------------------------------------- elements --

  function el(name, attrs, parent) {
    const node = document.createElementNS(NS, name);
    for (const k in attrs) if (attrs[k] != null) node.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(node);
    return node;
  }

  function html(name, className, parent) {
    const node = document.createElement(name);
    if (className) node.className = className;
    if (parent) parent.appendChild(node);
    return node;
  }

  // Series and category names arrive from the API and from CSV imports, so they
  // are untrusted. Everything user-visible goes in as text, never as markup.
  function text(node, value) {
    node.textContent = value == null ? "" : String(value);
    return node;
  }

  let uid = 0;
  const nextId = () => "vc-" + (++uid);

  // ------------------------------------------------------------ the chrome --

  function emptyState(host, message) {
    host.innerHTML = "";
    const box = html("div", "vc-empty", host);
    box.style.cssText = "text-align:center;color:" + PALETTE.inkSoft + ";font-size:12px;padding:28px 12px;";
    text(box, message || "No data yet.");
    return host;
  }

  // The table every chart carries.
  //
  // Not a fallback — a peer. A tooltip enhances, it never gates: any value the
  // hover layer shows has to be reachable without a pointer at all.
  function dataTable(host, { index, categories, data, valueFormatter }) {
    const wrap = html("div", "vc-table-wrap", host);
    wrap.hidden = true;
    wrap.style.cssText = "margin-top:10px;overflow-x:auto;";

    const table = html("table", "vc-table", wrap);
    table.style.cssText = "width:100%;border-collapse:collapse;font-size:11.5px;";

    const thead = html("thead", null, table);
    const hr = html("tr", null, thead);
    const th0 = html("th", null, hr);
    text(th0, index.label || "");
    th0.style.cssText = "text-align:left;padding:4px 8px 4px 0;border-bottom:1px solid " + PALETTE.grid + ";font-weight:500;color:" + PALETTE.inkSoft + ";";
    categories.forEach((c) => {
      const th = html("th", null, hr);
      text(th, c.label);
      th.style.cssText = "text-align:right;padding:4px 0 4px 8px;border-bottom:1px solid " + PALETTE.grid + ";font-weight:500;color:" + PALETTE.inkSoft + ";";
    });

    const tbody = html("tbody", null, table);
    data.forEach((row) => {
      const tr = html("tr", null, tbody);
      const td0 = html("td", null, tr);
      text(td0, row[index.key]);
      td0.style.cssText = "padding:4px 8px 4px 0;border-bottom:1px solid " + PALETTE.grid + ";";
      categories.forEach((c) => {
        const td = html("td", null, tr);
        text(td, row[c.key] == null ? "—" : (valueFormatter ? valueFormatter(row[c.key]) : compact(row[c.key])));
        td.style.cssText = "padding:4px 0 4px 8px;text-align:right;border-bottom:1px solid " + PALETTE.grid + ";font-variant-numeric:tabular-nums;";
      });
    });

    const toggle = html("button", "vc-table-toggle", host);
    toggle.type = "button";
    text(toggle, "Show data");
    toggle.style.cssText = "background:none;border:none;padding:4px 0;margin-top:2px;font:inherit;font-size:10.5px;color:" + PALETTE.inkSoft + ";cursor:pointer;text-decoration:underline;";
    toggle.setAttribute("aria-expanded", "false");
    toggle.addEventListener("click", () => {
      wrap.hidden = !wrap.hidden;
      toggle.setAttribute("aria-expanded", String(!wrap.hidden));
      text(toggle, wrap.hidden ? "Show data" : "Hide data");
    });
    // The button reads better after the table in the DOM but before it visually.
    host.insertBefore(toggle, wrap);
    return wrap;
  }

  // A legend, for two or more series. One series needs none — there is only one
  // colour, and the title already says what is plotted.
  function legend(host, categories) {
    if (categories.length < 2) return null;
    const box = html("div", "vc-legend", host);
    box.style.cssText = "display:flex;gap:14px;flex-wrap:wrap;margin-bottom:8px;";
    categories.forEach((c) => {
      const item = html("span", null, box);
      item.style.cssText = "display:inline-flex;align-items:center;gap:6px;font-size:11px;color:" + PALETTE.inkSoft + ";";
      const key = html("span", null, item);
      // Legends mirror the mark: a line for lines, a rect for bars and areas.
      key.style.cssText = c.mark === "line"
        ? "width:14px;height:2px;border-radius:1px;background:" + c.color + ";"
        : "width:10px;height:10px;border-radius:2px;background:" + c.color + ";";
      const label = html("span", null, item);
      text(label, c.label);
    });
    return box;
  }

  // One tooltip, listing every series at the hovered position — so the pointer
  // never has to land on a particular line to get a value.
  function tooltip(host) {
    const box = html("div", "vc-tooltip", host);
    box.style.cssText =
      "position:absolute;pointer-events:none;opacity:0;transition:opacity .12s;" +
      "background:" + PALETTE.surface + ";border:1px solid " + PALETTE.grid + ";border-radius:7px;" +
      "padding:8px 10px;font-size:11.5px;box-shadow:0 4px 14px rgba(32,36,31,.10);z-index:5;min-width:104px;";
    box.setAttribute("role", "status");

    return {
      node: box,
      show(x, y, title, rows) {
        box.innerHTML = "";
        const head = html("div", null, box);
        text(head, title);
        head.style.cssText = "font-size:10px;text-transform:uppercase;letter-spacing:.7px;color:" + PALETTE.inkSoft + ";margin-bottom:5px;";

        rows.forEach((r) => {
          const line = html("div", null, box);
          line.style.cssText = "display:flex;align-items:center;gap:7px;margin-top:3px;";
          const key = html("span", null, line);
          // A short stroke, not a filled box — at tooltip density a box is
          // data-weight ink doing a label's job.
          key.style.cssText = "width:10px;height:2px;border-radius:1px;flex:none;background:" + r.color + ";";
          const val = html("span", null, line);
          // Value leads, label follows: the reader already knows the series and
          // came here for the number.
          text(val, r.value);
          val.style.cssText = "font-weight:600;color:" + PALETTE.ink + ";font-variant-numeric:tabular-nums;";
          if (rows.length > 1 || r.showLabel) {
            const lab = html("span", null, line);
            text(lab, r.label);
            lab.style.cssText = "color:" + PALETTE.inkSoft + ";";
          }
        });

        box.style.opacity = "1";
        // Positioned after painting so the measured width is the real one.
        const hostRect = host.getBoundingClientRect();
        const w = box.offsetWidth, h = box.offsetHeight;
        let left = x + 14, top = y - h - 10;
        if (left + w > hostRect.width) left = x - w - 14;
        if (left < 0) left = 4;
        if (top < 0) top = y + 16;
        box.style.left = left + "px";
        box.style.top = top + "px";
      },
      hide() { box.style.opacity = "0"; },
    };
  }

  function frame(host, height) {
    host.innerHTML = "";
    host.style.position = "relative";
    return host;
  }

  // ------------------------------------------------------- line and area ----

  // Trend over time. `area: true` washes the fill at 10% — a single series
  // reads better filled; several read better as bare lines.
  function lineChart(host, opts) {
    const {
      data = [], index = "date", categories = [], colors,
      valueFormatter = compact, height = 200, area = false,
      yDomain, zeroBased = false, indexLabel = "", showTable = true,
      animate = true, ariaLabel,
    } = opts;

    if (!data.length || !categories.length) return emptyState(host, opts.emptyMessage);

    const series = categories.map((key, i) => ({
      key,
      label: typeof key === "string" ? key : key.label,
      color: (colors && colors[i]) || PALETTE.categorical[i] || PALETTE.deemphasis,
      mark: area && categories.length === 1 ? "rect" : "line",
    }));

    frame(host, height);
    legend(host, series);

    const pad = { top: 12, right: 14, bottom: 26, left: 44 };
    // The viewBox is measured from the host rather than fixed at some nominal
    // width. A fixed 640-unit box stretched to fit with preserveAspectRatio
    // "none" scales x and y by different factors, which squashes every axis
    // label horizontally — the text is the first thing to look wrong and the
    // last thing anyone suspects. One viewBox unit = one pixel, no distortion.
    const W = Math.max(280, Math.round(host.clientWidth || 640));
    const H = height;
    const plot = { x0: pad.left, x1: W - pad.right, y0: pad.top, y1: H - pad.bottom };

    const svg = el("svg", {
      viewBox: `0 0 ${W} ${H}`, width: "100%", height,
      role: "img",
      "aria-label": ariaLabel || (series.map((s) => s.label).join(", ") + " over " + (indexLabel || "time")),
    }, host);
    svg.style.display = "block";

    const values = [];
    data.forEach((row) => series.forEach((s) => values.push(row[s.key])));
    const domain = yDomain || domainOf(values, { zeroBased });
    // Ticks that fall outside the padded domain are dropped, which on a narrow
    // range can leave a single gridline — an axis the eye cannot read a value
    // against. Ask for more until at least three survive, then stop: past a
    // point more gridlines are just more ink competing with the data.
    let ticks = [];
    for (let want = 4; want <= 9; want++) {
      const candidate = niceTicks(domain[0], domain[1], want)
        .filter((t) => t >= domain[0] && t <= domain[1]);
      if (candidate.length > ticks.length) ticks = candidate;
      if (ticks.length >= 3) break;
    }

    const xAt = (i) => data.length === 1
      ? (plot.x0 + plot.x1) / 2
      : scale(i, [0, data.length - 1], [plot.x0, plot.x1]);
    const yAt = (v) => scale(v, domain, [plot.y1, plot.y0]);

    // Gridlines: hairline, solid, one step off the surface. Never dashed —
    // a dashed grid competes with the data for attention.
    ticks.forEach((t) => {
      const y = yAt(t);
      if (y < plot.y0 - 1 || y > plot.y1 + 1) return;
      el("line", { x1: plot.x0, x2: plot.x1, y1: y, y2: y, stroke: PALETTE.grid, "stroke-width": 1 }, svg);
      const label = el("text", {
        x: plot.x0 - 8, y: y + 3.5, "text-anchor": "end",
        "font-size": 10, fill: PALETTE.inkSoft,
      }, svg);
      text(label, valueFormatter(t));
    });

    // X labels, thinned so they never collide.
    const every = Math.max(1, Math.ceil(data.length / 7));
    data.forEach((row, i) => {
      if (i % every && i !== data.length - 1) return;
      const label = el("text", {
        x: xAt(i), y: plot.y1 + 15, "text-anchor": "middle",
        "font-size": 10, fill: PALETTE.inkSoft,
      }, svg);
      text(label, row[index]);
    });

    // The marks.
    series.forEach((s) => {
      const points = [];
      data.forEach((row, i) => {
        const v = row[s.key];
        if (typeof v === "number" && isFinite(v)) points.push([xAt(i), yAt(v)]);
      });
      if (!points.length) return;

      if (area) {
        el("path", { d: areaPath(points, plot.y1), fill: s.color, "fill-opacity": 0.1, stroke: "none" }, svg);
      }
      const path = el("path", {
        d: linePath(points), fill: "none", stroke: s.color,
        "stroke-width": 2, "stroke-linejoin": "round", "stroke-linecap": "round",
      }, svg);

      // Entry animation: the line draws itself. Cheap, and it makes a
      // re-render legible as a change rather than a flicker.
      if (animate && path.getTotalLength) {
        try {
          const len = path.getTotalLength();
          path.style.strokeDasharray = len;
          path.style.strokeDashoffset = len;
          path.style.transition = "stroke-dashoffset .6s ease-out";
          requestAnimationFrame(() => { path.style.strokeDashoffset = "0"; });
        } catch (_) { /* jsdom and friends have no geometry */ }
      }

      // The end marker, with a surface ring so it stays legible where series
      // cross. The last point is the one the reader looks for.
      const last = points[points.length - 1];
      el("circle", { cx: last[0], cy: last[1], r: 4, fill: s.color, stroke: PALETTE.surface, "stroke-width": 2 }, svg);
    });

    // The hover layer.
    const tip = tooltip(host);
    const cross = el("line", {
      x1: 0, x2: 0, y1: plot.y0, y2: plot.y1,
      stroke: PALETTE.axis, "stroke-width": 1, opacity: 0,
    }, svg);
    const dots = series.map((s) => el("circle", {
      r: 4.5, fill: s.color, stroke: PALETTE.surface, "stroke-width": 2, opacity: 0,
    }, svg));

    // The crosshair snaps to the nearest index, so the reader aims at a date
    // rather than at a 2px line.
    function nearest(clientX) {
      const rect = svg.getBoundingClientRect();
      const px = ((clientX - rect.left) / rect.width) * W;
      let best = 0, bestD = Infinity;
      for (let i = 0; i < data.length; i++) {
        const d = Math.abs(xAt(i) - px);
        if (d < bestD) { bestD = d; best = i; }
      }
      return best;
    }

    function moveTo(i, clientX, clientY) {
      const row = data[i];
      const x = xAt(i);
      cross.setAttribute("x1", x); cross.setAttribute("x2", x);
      cross.setAttribute("opacity", 0.25);

      const rows = [];
      series.forEach((s, si) => {
        const v = row[s.key];
        const has = typeof v === "number" && isFinite(v);
        dots[si].setAttribute("opacity", has ? 1 : 0);
        if (has) {
          dots[si].setAttribute("cx", x);
          dots[si].setAttribute("cy", yAt(v));
        }
        rows.push({ color: s.color, label: s.label, value: has ? valueFormatter(v) : "—", showLabel: series.length > 1 });
      });

      const rect = host.getBoundingClientRect();
      tip.show(clientX - rect.left, clientY - rect.top, row[index], rows);
    }

    function clear() {
      cross.setAttribute("opacity", 0);
      dots.forEach((d) => d.setAttribute("opacity", 0));
      tip.hide();
    }

    svg.addEventListener("pointermove", (e) => moveTo(nearest(e.clientX), e.clientX, e.clientY));
    svg.addEventListener("pointerleave", clear);

    // Keyboard gets the same detail as hover, which is the whole point of
    // "tooltips enhance, they never gate".
    svg.setAttribute("tabindex", "0");
    let focusIndex = data.length - 1;
    svg.addEventListener("focus", () => {
      const r = svg.getBoundingClientRect();
      moveTo(focusIndex, r.left + (xAt(focusIndex) / W) * r.width, r.top + r.height / 2);
    });
    svg.addEventListener("blur", clear);
    svg.addEventListener("keydown", (e) => {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      e.preventDefault();
      focusIndex = Math.max(0, Math.min(data.length - 1, focusIndex + (e.key === "ArrowRight" ? 1 : -1)));
      const r = svg.getBoundingClientRect();
      moveTo(focusIndex, r.left + (xAt(focusIndex) / W) * r.width, r.top + r.height / 2);
    });

    if (showTable) {
      dataTable(host, {
        index: { key: index, label: indexLabel || "Period" },
        categories: series, data, valueFormatter,
      });
    }
    return host;
  }

  function areaChart(host, opts) {
    return lineChart(host, Object.assign({}, opts, { area: true }));
  }

  // ------------------------------------------------------------- bar chart --

  // Horizontal, because the categories here are names — server names, outlets —
  // and a horizontal bar gives a long label room to be read.
  function barChart(host, opts) {
    const {
      data = [], index = "name", category = "value",
      valueFormatter = compact, colors, color,
      barHeight = 22, gap = 10, showValue = true, showTable = true,
      ariaLabel, maxValue,
    } = opts;

    if (!data.length) return emptyState(host, opts.emptyMessage);

    frame(host);

    const labelW = 132, valueW = 54;
    // Measured, for the same reason as the line chart: a stretched viewBox
    // distorts the category labels.
    const W = Math.max(280, Math.round(host.clientWidth || 640));
    const H = data.length * (barHeight + gap) + 4;

    const svg = el("svg", {
      viewBox: `0 0 ${W} ${H}`, width: "100%", height: H,
      role: "img", "aria-label": ariaLabel || "Comparison by " + index,
    }, host);
    svg.style.display = "block";

    const values = data.map((r) => r[category]).filter((v) => typeof v === "number");
    // Bars are always zero-based. A truncated bar axis misstates proportion,
    // which is the whole reason someone is looking at bars.
    const max = maxValue != null ? maxValue : Math.max(1, ...values);
    const x0 = labelW, x1 = W - valueW;

    const tip = tooltip(host);

    data.forEach((row, i) => {
      const y = i * (barHeight + gap) + 2;
      const v = row[category];
      const has = typeof v === "number" && isFinite(v);
      const w = has ? Math.max(2, ((v / max) * (x1 - x0))) : 0;
      const fill = color || (colors && colors[i]) ||
        PALETTE.sequential[Math.min(PALETTE.sequential.length - 1,
          Math.floor((has ? v / max : 0) * PALETTE.sequential.length))] || PALETTE.sequential[3];

      const label = el("text", {
        x: labelW - 12, y: y + barHeight / 2 + 4, "text-anchor": "end",
        "font-size": 11.5, fill: PALETTE.ink,
      }, svg);
      text(label, row[index]);

      // The track, so a short bar still reads as "out of" something.
      el("rect", { x: x0, y, width: x1 - x0, height: barHeight, rx: 4, fill: PALETTE.grid, "fill-opacity": 0.5 }, svg);

      const bar = el("rect", {
        x: x0, y, width: 0, height: barHeight, rx: 4, fill,
      }, svg);
      // Grow from the baseline. Animating width rather than a transform keeps
      // the rounded data-end anchored where it belongs.
      requestAnimationFrame(() => {
        bar.style.transition = "width .5s ease-out";
        bar.setAttribute("width", w);
      });

      if (showValue) {
        const val = el("text", {
          x: x1 + 8, y: y + barHeight / 2 + 4, "font-size": 11.5,
          fill: PALETTE.ink, "font-variant-numeric": "tabular-nums",
        }, svg);
        text(val, has ? valueFormatter(v) : "—");
      }

      // The mark is the hit target, and the target is bigger than the mark.
      const hit = el("rect", {
        x: 0, y: y - gap / 2, width: W, height: barHeight + gap,
        fill: "transparent", style: "cursor:default",
      }, svg);
      hit.addEventListener("pointermove", (e) => {
        bar.setAttribute("fill-opacity", 0.82);
        const rect = host.getBoundingClientRect();
        tip.show(e.clientX - rect.left, e.clientY - rect.top, row[index],
          [{ color: fill, label: opts.valueLabel || "", value: has ? valueFormatter(v) : "—", showLabel: !!opts.valueLabel }]);
      });
      hit.addEventListener("pointerleave", () => {
        bar.setAttribute("fill-opacity", 1);
        tip.hide();
      });
    });

    if (showTable) {
      dataTable(host, {
        index: { key: index, label: opts.indexLabel || "" },
        categories: [{ key: category, label: opts.valueLabel || "Value", color: PALETTE.sequential[3] }],
        data, valueFormatter,
      });
    }
    return host;
  }

  // ----------------------------------------------------------------- meter --

  // A single ratio against a limit. The unfilled track is a lighter step of the
  // same ramp, so the state reads across the whole bar rather than only where
  // the fill stops.
  function meter(host, opts) {
    const { value = 0, max = 100, label = "", valueFormatter = compact, status, height = 8 } = opts;
    host.innerHTML = "";
    const pct = max > 0 ? Math.max(0, Math.min(1, value / max)) : 0;
    const fill = status ? PALETTE.status[status] : PALETTE.sequential[3];

    const row = html("div", null, host);
    row.style.cssText = "display:flex;align-items:center;gap:10px;";

    if (label) {
      const l = html("span", null, row);
      text(l, label);
      l.style.cssText = "font-size:11.5px;color:" + PALETTE.ink + ";min-width:96px;";
    }

    const track = html("div", null, row);
    track.style.cssText = "flex:1;height:" + height + "px;border-radius:" + height / 2 + "px;background:" + PALETTE.grid + ";overflow:hidden;";
    track.setAttribute("role", "meter");
    track.setAttribute("aria-valuenow", String(value));
    track.setAttribute("aria-valuemin", "0");
    track.setAttribute("aria-valuemax", String(max));
    track.setAttribute("aria-label", label || "value");

    const bar = html("div", null, track);
    bar.style.cssText = "height:100%;width:0;border-radius:" + height / 2 + "px;background:" + fill + ";transition:width .5s ease-out;";
    requestAnimationFrame(() => { bar.style.width = (pct * 100).toFixed(1) + "%"; });

    const v = html("span", null, row);
    text(v, valueFormatter(value));
    v.style.cssText = "font-size:11.5px;color:" + PALETTE.ink + ";font-variant-numeric:tabular-nums;min-width:38px;text-align:right;";
    return host;
  }

  global.VeroCharts = {
    line: lineChart, area: areaChart, bar: barChart, meter, empty: emptyState,
    PALETTE,
    // Exported for tests — the parts that decide where a pixel goes.
    _: { niceTicks, niceNum, scale, domainOf, compact, linePath, areaPath, round },
  };

  if (typeof module !== "undefined" && module.exports) module.exports = global.VeroCharts;
})(typeof window !== "undefined" ? window : globalThis);
