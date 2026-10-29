import { Resvg } from '@resvg/resvg-js';

const MAX_SIDE = 1024;
// resvg loads local files referenced by <image>/<feImage>, so model output must stay self-contained:
// only same-document references are allowed.
const UNSAFE_SVG = /<(?:[\w-]+:)?(?:image|feImage|foreignObject|script)\b|<!(?:DOCTYPE|ENTITY)|@import|\bhref\s*=\s*(?!["']?#)|url\(\s*(?!["']?#)/i;

/** Rasterizes a model-written SVG to a PNG whose longer side is MAX_SIDE pixels. */
export function renderSvg(svg: string): Buffer<ArrayBuffer> {
  if (UNSAFE_SVG.test(svg)) throw Object.assign(new Error('image_unsafe'), { code: 'image_unsafe' });
  // Measuring needs no fonts; skipping them keeps the extra parse cheap.
  const { width, height } = new Resvg(svg, { font: { loadSystemFonts: false } });
  if (!(width > 0 && height > 0)) throw Object.assign(new Error('image_invalid'), { code: 'image_invalid' });
  return new Resvg(svg, {
    fitTo: width >= height ? { mode: 'width', value: MAX_SIDE } : { mode: 'height', value: MAX_SIDE },
    // LINE dark mode would hide dark strokes on a transparent canvas.
    background: 'white',
    // Native buffers are never SharedArrayBuffer-backed.
  }).render().asPng() as Buffer<ArrayBuffer>;
}
