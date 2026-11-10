// Writes e2e/fixtures/figures.pdf: one page with an embedded RGB picture
// (64 x 48, a colour gradient) and a vector line graph drawn with path
// operators, each with a caption. Run: node e2e/fixtures/make-figures-pdf.mjs
import { writeFileSync } from 'node:fs';

const W = 64, H = 48;
const rgb = Buffer.alloc(W * H * 3);
for (let y = 0; y < H; y += 1) for (let x = 0; x < W; x += 1) { const o = (y * W + x) * 3; rgb[o] = x * 4; rgb[o + 1] = y * 5; rgb[o + 2] = 200; }
const content = [
  'BT /F1 18 Tf 72 720 Td (Figure 1. A photograph) Tj ET',
  'q 256 0 0 192 72 500 cm /Im1 Do Q',
  '0 0 1 RG 4 w 72 260 m 220 420 l 380 300 l 520 400 l S',
  '0 g 1 w 72 260 m 540 260 l S 72 260 m 72 440 l S',
  'BT /F1 14 Tf 72 230 Td (Figure 2. A line graph) Tj ET',
].join('\n');
const objects = [
  '<< /Type /Catalog /Pages 2 0 R >>',
  '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
  '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /XObject << /Im1 5 0 R >> /Font << /F1 6 0 R >> >> >>',
  Buffer.concat([Buffer.from(`<< /Length ${Buffer.byteLength(content)} >>\nstream\n`), Buffer.from(content), Buffer.from('\nendstream')]),
  Buffer.concat([Buffer.from(`<< /Type /XObject /Subtype /Image /Width ${W} /Height ${H} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Length ${rgb.length} >>\nstream\n`), rgb, Buffer.from('\nendstream')]),
  '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
];
const parts = [Buffer.from('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n', 'latin1')];
const offsets = [];
let length = parts[0].length;
objects.forEach((body, i) => {
  offsets.push(length);
  const chunk = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`), Buffer.isBuffer(body) ? body : Buffer.from(body), Buffer.from('\nendobj\n')]);
  parts.push(chunk);
  length += chunk.length;
});
const xref = [`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`, ...offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`), `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${length}\n%%EOF\n`].join('');
parts.push(Buffer.from(xref));
writeFileSync(new URL('./figures.pdf', import.meta.url), Buffer.concat(parts));
