import { loadPdfLibrary } from './payment-request2-reader-browser.js';

const FALLBACK = 'Preview unavailable. Use Open above to view the document. You can still review and submit this request.';
const clearCanvas = canvas => { if (canvas) { canvas.width = 0; canvas.height = 0; } };

// One page at a time, with no native PDF plugin, annotations, or document actions.
// Each mounted source owns its resources and cannot paint after disposal.
export function createPdfPreview(blob, io) {
  let closed = false, busy = false, loading, doc, renderTask, activeCanvas, displayedCanvas, timer;
  let finish;
  const stopped = new Promise(resolve => { finish = resolve; });
  function dispose() {
    if (closed) return;
    closed = true; clearTimeout(timer);
    renderTask?.cancel();
    void loading?.destroy().catch(() => {});
    clearCanvas(activeCanvas); clearCanvas(displayedCanvas);
    finish(false);
  }
  function fail() { if (!closed) { io.status(FALLBACK); dispose(); } }
  function deadline() { clearTimeout(timer); timer = setTimeout(fail, io.timeoutMs ?? 30000); }
  async function render(n) {
    if (closed || busy || !doc || !Number.isInteger(n) || n < 1 || n > doc.numPages) return false;
    busy = true; deadline(); io.status(`Loading page ${n}…`);
    let page, canvas;
    try {
      page = await doc.getPage(n); if (closed) return false;
      const original = page.getViewport({ scale: 1 });
      if (!(original.width > 0 && original.height > 0 && Number.isFinite(original.width * original.height))) throw Error('Invalid page dimensions');
      const scale = Math.min(Math.max(1, io.width() || 400) * Math.max(1, Math.min(io.pixelRatio() || 1, 2)) / original.width, Math.sqrt(8000000 / (original.width * original.height)), 16384 / Math.max(original.width, original.height));
      const viewport = page.getViewport({ scale });
      canvas = io.createCanvas(); activeCanvas = canvas;
      canvas.width = Math.max(1, Math.floor(viewport.width)); canvas.height = Math.max(1, Math.floor(viewport.height));
      renderTask = page.render({ canvasContext: canvas.getContext('2d'), viewport });
      await renderTask.promise; if (closed) return false;
      clearCanvas(displayedCanvas); displayedCanvas = canvas;
      io.present(canvas, n, doc.numPages); return true;
    } catch { fail(); return false; }
    finally {
      renderTask = null; activeCanvas = null; busy = false; clearTimeout(timer);
      if (canvas !== displayedCanvas || closed) clearCanvas(canvas);
      page?.cleanup();
    }
  }
  io.status('Loading document…'); deadline();
  const task = (async () => {
    try {
      const pdfjs = await io.loadPdf(); if (closed) return false;
      const data = new Uint8Array(await blob.arrayBuffer()); if (closed) return false;
      loading = pdfjs.getDocument({ data, isEvalSupported: false, enableXfa: false, useSystemFonts: true });
      loading.onPassword = fail;
      doc = await loading.promise; if (closed) return false;
      return await render(1);
    } catch { fail(); return false; }
  })();
  return { ready: Promise.race([task, stopped]), showPage: n => Promise.race([render(n), stopped]), dispose };
}

export function mountPdfPreview(container, blob) {
  const make = (tag, className, text) => {
    const el = document.createElement(tag); el.className = className;
    if (text) el.textContent = text;
    return el;
  };
  const viewer = make('div', 'pr2-pdf-viewer');
  const stage = make('div', 'pr2-pdf-stage');
  const status = make('p', 'pr2-pdf-status'); status.setAttribute('role', 'status');
  const toolbar = make('div', 'pr2-pdf-toolbar'); toolbar.setAttribute('aria-label', 'Document pages');
  const previous = make('button', 'bcn-btn bcn-btn--ghost', 'Previous');
  const next = make('button', 'bcn-btn bcn-btn--ghost', 'Next');
  const label = make('span', ''); label.setAttribute('aria-live', 'polite');
  previous.type = next.type = 'button'; previous.disabled = next.disabled = true;
  toolbar.append(previous, label, next); stage.append(status); viewer.append(stage, toolbar); container.append(viewer);
  let current = 1;
  const preview = createPdfPreview(blob, {
    loadPdf: loadPdfLibrary,
    createCanvas: () => document.createElement('canvas'),
    width: () => stage.clientWidth - 16,
    pixelRatio: () => window.devicePixelRatio,
    status(message) { previous.disabled = next.disabled = true; status.textContent = message; stage.replaceChildren(status); },
    present(canvas, n, total) {
      current = n; canvas.setAttribute('role', 'img'); canvas.setAttribute('aria-label', `Source document, page ${n} of ${total}. Use Open for the original PDF.`);
      stage.replaceChildren(canvas); stage.scrollTop = 0;
      label.textContent = `Page ${n} of ${total}`; previous.disabled = n <= 1; next.disabled = n >= total;
    },
  });
  previous.addEventListener('click', () => { void preview.showPage(current - 1); });
  next.addEventListener('click', () => { void preview.showPage(current + 1); });
  return () => { preview.dispose(); viewer.remove(); };
}
