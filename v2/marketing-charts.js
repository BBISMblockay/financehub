/* Small SVG helpers shared by Marketing performance pages — gradients, plot
   frame, and class names so charts do not each invent their own 1990s look. */
(function () {
  'use strict';

  let _seq = 0;
  function nextId(prefix) {
    _seq += 1;
    return `${prefix}${_seq}`;
  }

  function gradientDefs(id, color) {
    return `<linearGradient id="${id}" x1="0" x2="0" y1="0" y2="1">
      <stop offset="0%" stop-color="${color}" stop-opacity=".2"/>
      <stop offset="100%" stop-color="${color}" stop-opacity="0"/>
    </linearGradient>`;
  }

  function areaClosed(path, xLast, xFirst, yBase) {
    if (!path) return '';
    return `${path} L${xLast.toFixed(1)},${yBase.toFixed(1)} L${xFirst.toFixed(1)},${yBase.toFixed(1)} Z`;
  }

  function svgOpen({ w, h, aria }) {
    const label = String(aria ?? '').replaceAll('"', '&quot;');
    return `<svg class="mkt-chart-svg" viewBox="0 0 ${w} ${h}" preserveAspectRatio="xMidYMid meet" role="img"`
      + (label ? ` aria-label="${label}"` : '') + '>';
  }

  window.SiloMarketingCharts = { nextId, gradientDefs, areaClosed, svgOpen };
})();