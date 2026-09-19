import { readLocally } from './payment-request2-reader.js';

// Exact versions, lazy loaded. These URLs download code/language data only;
// invoice bytes go to local workers, never to the CDN or an AI provider.
const PDF_BASE = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38';
const OCR_BASE = 'https://cdn.jsdelivr.net/npm/tesseract.js@6.0.1';
const MAX_PIXELS = 8000000;
export async function loadPdfLibrary() {
  const pdfjs = await import(`${PDF_BASE}/build/pdf.mjs`);
  pdfjs.GlobalWorkerOptions.workerSrc = `${PDF_BASE}/build/pdf.worker.mjs`;
  return pdfjs;
}
export async function readDocumentOnDevice(file, { signal, progress } = {}) {
  const control = new AbortController();
  const abort = () => control.abort();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  const timer = setTimeout(abort, 90000);
  let worker, loading, stopped = false;
  const stop = () => { stopped = true; void worker?.terminate().catch(() => {}); void loading?.destroy().catch(() => {}); };
  control.signal.addEventListener('abort', stop, { once: true });
  const check = () => { if (control.signal.aborted) throw Error('Reading stopped or took too long. Try a smaller document, or enter details manually.'); };
  // Promise race unlocks the UI even if an asset download or worker stalls.
  let rejectAbort;
  const aborted = new Promise((_, reject) => { rejectAbort = () => reject(Error('Reading stopped or took too long. You can retry or enter details manually.')); control.signal.addEventListener('abort', rejectAbort, { once: true }); });
  const task = async () => readLocally(file, {
    signal: control.signal, progress,
    async openPdf(blob) {
      check(); const pdfjs = await loadPdfLibrary(); check();
      loading = pdfjs.getDocument({ data: new Uint8Array(await blob.arrayBuffer()), isEvalSupported: false, enableXfa: false, useSystemFonts: true });
      loading.onPassword = () => { void loading.destroy().catch(() => {}); };
      let doc;
      try { doc = await loading.promise; check(); }
      catch { throw Error('This PDF could not be opened. Use an unlocked PDF or enter details manually.'); }
      return {
        numPages: doc.numPages, destroy: () => doc.destroy(),
        async getPage(n) {
          const page = await doc.getPage(n); let canvas;
          return {
            getTextContent: () => page.getTextContent(),
            async hasImages() {
              const ops = await page.getOperatorList();
              return ops.fnArray.some(op => [pdfjs.OPS.paintImageXObject, pdfjs.OPS.paintInlineImageXObject, pdfjs.OPS.paintImageMaskXObject].includes(op));
            },
            async image() {
              check(); const original = page.getViewport({ scale: 1 });
              const scale = Math.min(2, Math.sqrt(MAX_PIXELS / (original.width * original.height)));
              const viewport = page.getViewport({ scale });
              canvas = document.createElement('canvas'); canvas.width = Math.max(1, Math.floor(viewport.width)); canvas.height = Math.max(1, Math.floor(viewport.height));
              await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise; check(); return canvas;
            },
            cleanup() { if (canvas) { canvas.width = 0; canvas.height = 0; } page.cleanup(); },
          };
        },
      };
    },
    async recognize(input) {
      check();
      if (!worker) {
        const { default: tesseract } = await import(`${OCR_BASE}/dist/tesseract.esm.min.js`); check();
        const created = await tesseract.createWorker('eng', 1, {
          workerPath: `${OCR_BASE}/dist/worker.min.js`,
          corePath: 'https://cdn.jsdelivr.net/npm/tesseract.js-core@6.0.0',
          langPath: 'https://cdn.jsdelivr.net/npm/@tesseract.js-data/eng@1.0.0/4.0.0_best_int',
        });
        if (stopped) { await created.terminate(); check(); }
        worker = created;
      }
      let bitmap, canvas;
      try {
        // Bound decoded image size before passing it to the OCR worker.
        if (input instanceof Blob) {
          bitmap = await createImageBitmap(input); check();
          const scale = Math.min(1, Math.sqrt(MAX_PIXELS / (bitmap.width * bitmap.height)));
          canvas = document.createElement('canvas'); canvas.width = Math.max(1, Math.floor(bitmap.width * scale)); canvas.height = Math.max(1, Math.floor(bitmap.height * scale));
          canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height); input = canvas;
        }
        const { data } = await worker.recognize(input); check(); return data.text || '';
      } finally { bitmap?.close(); if (canvas) { canvas.width = 0; canvas.height = 0; } }
    },
  });
  try { check(); return await Promise.race([task(), aborted]); }
  catch (error) { if (control.signal.aborted) throw error; throw Error(`Could not read this document on your device. ${/PDF|pages|text|invoice|4 MB/.test(error.message) ? error.message : 'Try a clearer file or enter details manually.'}`); }
  finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); control.signal.removeEventListener('abort', rejectAbort); stop(); }
}
