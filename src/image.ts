import { Resvg } from '@resvg/resvg-js';
import type { CjkFont } from './config.js';

const MAX_SIDE = 1024;
// resvg loads local files referenced by <image>/<feImage>, so model output must stay self-contained:
// only same-document references are allowed.
const UNSAFE_SVG = /<(?:[\w-]+:)?(?:image|feImage|foreignObject|script)\b|<!(?:DOCTYPE|ENTITY)|@import|\bhref\s*=\s*(?!["']?#)|url\(\s*(?!["']?#)/i;

/** Rasterizes a model-written SVG to a PNG whose longer side is MAX_SIDE pixels. */
export function renderSvg(svg: string, font?: CjkFont): Buffer<ArrayBuffer> {
  if (UNSAFE_SVG.test(svg)) throw Object.assign(new Error('image_unsafe'), { code: 'image_unsafe' });
  let width = 0;
  let height = 0;
  // Measuring needs no fonts; skipping them keeps the extra parse cheap.
  try { ({ width, height } = new Resvg(svg, { font: { loadSystemFonts: false } })); }
  catch { /* Malformed SVG is reported as invalid below. */ }
  if (!(width > 0 && height > 0)) throw Object.assign(new Error('image_invalid'), { code: 'image_invalid' });
  return new Resvg(svg, {
    fitTo: width >= height ? { mode: 'width', value: MAX_SIDE } : { mode: 'height', value: MAX_SIDE },
    // LINE dark mode would hide dark strokes on a transparent canvas.
    background: 'white',
    // Without fontconfig, resvg finds no system fonts and drops all text. An explicit file also
    // becomes the fallback for every family, so skipping the system scan (~0.3–3 s) loses nothing.
    ...(font ? { font: { fontFiles: [font.file], loadSystemFonts: false } } : {}),
    // Native buffers are never SharedArrayBuffer-backed.
  }).render().asPng() as Buffer<ArrayBuffer>;
}
