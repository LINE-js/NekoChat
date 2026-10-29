import PDFDocument from 'pdfkit';
import type { CjkFont } from './config.js';

/** Typesets plain text onto A4 pages; pdfkit wraps lines and breaks pages. */
export function renderPdf(content: string, font: CjkFont): Promise<Buffer<ArrayBuffer>> {
  const { promise, resolve, reject } = Promise.withResolvers<Buffer<ArrayBuffer>>();
  const chunks: Buffer<ArrayBuffer>[] = [];
  try {
    const doc = new PDFDocument({ size: 'A4', margin: 56 });
    doc.on('data', (chunk: Buffer<ArrayBuffer>) => chunks.push(chunk));
    doc.once('end', () => resolve(Buffer.concat(chunks)));
    doc.once('error', reject);
    (font.name === undefined ? doc.font(font.file) : doc.font(font.file, font.name))
      .fontSize(11).text(content, { lineGap: 4 });
    doc.end();
  } catch (error) {
    reject(error);
  }
  return promise;
}
