import test from 'node:test';
import assert from 'node:assert/strict';
import { renderSvg } from '../src/image.js';

const wrap = (body: string) => `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 10 40">${body}</svg>`;

test('SVGs that could load local files or external content are refused', () => {
  for (const body of [
    '<image href="/etc/a.png" width="1" height="1"/>',
    '<svg:image href="#a"/>',
    '<filter id="f"><feImage href="a.png"/></filter>',
    '<use xlink:href="file.svg#a"/>',
    '<use href=other.svg#a />',
    '<rect style="fill:url(/a.svg#p)" width="1" height="1"/>',
    '<style>@import "a.css";</style>',
    '<foreignObject/>',
    '<script>1</script>',
  ]) {
    assert.throws(() => renderSvg(wrap(body)), { code: 'image_unsafe' }, body);
  }
  assert.throws(() => renderSvg(`<!DOCTYPE svg [<!ENTITY x SYSTEM "file:///etc/passwd">]>${wrap('')}`), { code: 'image_unsafe' });
});

test('self-contained SVGs render with the longer side at 1024 px', () => {
  const png = renderSvg(wrap('<defs><radialGradient id="g"/></defs><rect id="a" width="10" height="40" fill="url(#g)"/><use href="#a"/>'));
  assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [256, 1024]);
});
