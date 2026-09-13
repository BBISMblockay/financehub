(function () {
  "use strict";
  const esc = (v) =>
    String(v ?? "").replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[c],
    );
  function render(model, currency) {
    const money = (n) =>
      new Intl.NumberFormat("en-US", {
        style: "currency",
        currency,
        notation: "compact",
        maximumFractionDigits: 1,
      }).format(n / 100);
    if (model.currentCash === null)
      return '<div class="cf-chart"><h3>Cash outlook</h3><p>A saved balance is needed for every selected cash account to draw the outlook.</p></div>';
    const width = 600,
      height = 180,
      left = 65,
      right = 12,
      top = 12,
      bottom = 27;
    const values = [
        ...model.daily,
        ...model.bankDaily,
        ...model.savedDaily,
      ].map((p) => p.balance),
      min = Math.min(0, ...values),
      max = Math.max(0, ...values),
      span = max - min || 100;
    const x = (i) =>
        left +
        (i * (width - left - right)) / Math.max(1, model.daily.length - 1),
      y = (v) => top + ((max - v) / span) * (height - top - bottom);
    const path = (series) =>
      series
        .map(
          (p, i) =>
            (i ? "L" : "M") + x(i).toFixed(2) + "," + y(p.balance).toFixed(2),
        )
        .join(" ");
    const grid = [min, (min + max) / 2, max]
      .map(
        (v) =>
          `<line x1="${left}" x2="${width - right}" y1="${y(v)}" y2="${y(v)}" class="cf-chart-grid"/><text x="${left - 8}" y="${y(v) + 3}" text-anchor="end">${esc(money(v))}</text>`,
      )
      .join("");
    const line = `<div class="cf-chart"><div class="cf-chart-title"><h3>Cash runway</h3><span><i class="cf-dot"></i> Planning <i class="cf-dot cf-dot-muted"></i> Bank trend ${model.whatIfCount ? '<i class="cf-dot cf-dot-scenario"></i> What if' : ""}</span></div><svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Projected cash ${esc(money(model.ending.at(-1)))}; lowest ${esc(money(model.low))} on ${esc(model.lowDate)}"><title>Bank trend, saved planning and what-if cash outlook</title>${grid}<path d="${path(model.bankDaily)}" class="cf-baseline"/><path d="${path(model.savedDaily)}" class="cf-forecast-line"/>${model.whatIfCount ? `<path d="${path(model.daily)}" class="cf-scenario-line"/>` : ""}<text x="${left}" y="${height - 5}">${esc(model.daily[0].date)}</text><text x="${width - right}" y="${height - 5}" text-anchor="end">${esc(model.futureEnd)}</text></svg></div>`;
    const months = new Map();
    model.cols.forEach((c, i) => {
      if (c.kind !== "forecast") return;
      const label = c.start.slice(0, 7);
      if (!months.has(label)) months.set(label, { in: 0, out: 0 });
      months.get(label).in += model.inflow[i];
      months.get(label).out -= model.outflow[i];
    });
    // Always group the source daily forecast, independently of the matrix unit.
    // The controller supplies a monthly model for this chart to avoid weeks crossing months.
    const bars = [...months],
      barMax = Math.max(1, ...bars.flatMap(([, v]) => [v.in, v.out])),
      slot = (width - left - right) / Math.max(1, bars.length),
      barWidth = Math.min(18, slot / 3);
    const rects = bars
      .map(([month, v], i) => {
        const center = left + slot * (i + 0.5);
        return (
          ["in", "out"]
            .map((key, k) => {
              const h = (v[key] / barMax) * (height - top - bottom);
              return `<rect x="${center + (k ? 3 : -barWidth - 3)}" y="${height - bottom - h}" width="${barWidth}" height="${h}" rx="2" class="cf-bar-${key}"><title>${esc(month + " " + (key === "in" ? "Money in" : "Money out") + " " + money(v[key]))}</title></rect>`;
            })
            .join("") +
          `<text x="${center}" y="${height - 5}" text-anchor="middle">${esc(month.slice(5))}/${esc(month.slice(2, 4))}</text>`
        );
      })
      .join("");
    return (
      line +
      `<div class="cf-chart"><div class="cf-chart-title"><h3>Money in / money out</h3><span><i class="cf-dot cf-dot-in"></i> In <i class="cf-dot cf-dot-out"></i> Out</span></div><svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Monthly forecast inflows and outflows"><title>Monthly forecast cash movements</title><text x="${left - 8}" y="${top + 3}" text-anchor="end">${esc(money(barMax))}</text><line x1="${left}" x2="${width - right}" y1="${height - bottom}" y2="${height - bottom}" class="cf-chart-grid"/>${rects}</svg></div>`
    );
  }
  window.SiloCashflowCharts = { render };
})();
