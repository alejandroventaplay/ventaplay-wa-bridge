/**
 * Vista previa de PDFs: dibuja la primera página en un canvas y la devuelve como
 * imagen (object URL). pdf.js se carga recién la primera vez que se necesita.
 */
type PdfJs = typeof import('pdfjs-dist');

let lib: Promise<PdfJs> | null = null;
function loadPdfJs(): Promise<PdfJs> {
  lib ??= Promise.all([
    import('pdfjs-dist'),
    import('pdfjs-dist/build/pdf.worker.min.mjs?url'),
  ]).then(([pdfjs, worker]) => {
    pdfjs.GlobalWorkerOptions.workerSrc = (worker as { default: string }).default;
    return pdfjs;
  });
  return lib;
}

const cache = new Map<string, Promise<PdfPreview>>();

export interface PdfPreview {
  /** imagen PNG de la primera página */
  url: string;
  pages: number;
  width: number;
  height: number;
}

export function isPdf(mimetype: string | null | undefined, fileName?: string | null): boolean {
  return (mimetype ?? '').toLowerCase().includes('pdf') || /\.pdf$/i.test(fileName ?? '');
}

/**
 * Primera página del PDF en `src` (object URL o URL) a `targetWidth` px de ancho.
 * Se guarda en caché por `key` para no volver a dibujarla.
 */
export function pdfFirstPage(key: string, src: string, targetWidth: number): Promise<PdfPreview> {
  const ck = `${key}@${targetWidth}`;
  let hit = cache.get(ck);
  if (!hit) {
    hit = (async () => {
      const pdfjs = await loadPdfJs();
      const doc = await pdfjs.getDocument({ url: src }).promise;
      try {
        const page = await doc.getPage(1);
        const base = page.getViewport({ scale: 1 });
        const ratio = window.devicePixelRatio || 1;
        const viewport = page.getViewport({ scale: (targetWidth / base.width) * ratio });
        const canvas = document.createElement('canvas');
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('canvas no disponible');
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        await page.render({ canvasContext: ctx, viewport }).promise;
        const blob = await new Promise<Blob>((ok, fail) =>
          canvas.toBlob((b) => (b ? ok(b) : fail(new Error('no se pudo dibujar'))), 'image/png'),
        );
        return {
          url: URL.createObjectURL(blob),
          pages: doc.numPages,
          width: canvas.width / ratio,
          height: canvas.height / ratio,
        };
      } finally {
        void doc.destroy();
      }
    })();
    hit.catch(() => cache.delete(ck));
    cache.set(ck, hit);
  }
  return hit;
}
