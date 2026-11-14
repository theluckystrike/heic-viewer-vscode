'use strict';
// Minimal PDF writer for the contact sheet: one page per JPEG, the JPEG embedded as is (DCTDecode), page size = image
// size at 150 dpi so a 1754 x 2480 px sheet prints as A4. No fonts, no compression of our own, no dependencies.

/** pages: [{ jpeg: Uint8Array, width, height }], title -> Buffer */
function makePdf(pages, title = 'Contact sheet') {
  const parts = [];
  const offsets = [];
  let size = 0;
  const push = (b) => { const buf = Buffer.isBuffer(b) ? b : Buffer.from(b, 'latin1'); parts.push(buf); size += buf.length; };
  const obj = (n, body) => { offsets[n] = size; push(`${n} 0 obj\n`); if (Array.isArray(body)) body.forEach(push); else push(body); push('\nendobj\n'); };
  push('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n');
  const n = pages.length;
  // 1 catalog, 2 pages, 3 info, then per page: page, content, image
  const kids = pages.map((_, i) => `${4 + i * 3} 0 R`).join(' ');
  obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
  obj(2, `<< /Type /Pages /Kids [${kids}] /Count ${n} >>`);
  const esc = (s) => String(s).replace(/[\\()]/g, (c) => `\\${c}`).replace(/[^\x20-\x7e]/g, '?');
  obj(3, `<< /Title (${esc(title)}) /Producer (HEIC Viewer by Zovo) >>`);
  pages.forEach((p, i) => {
    const pageN = 4 + i * 3, contN = pageN + 1, imgN = pageN + 2;
    const w = Math.round((p.width * 72 / 150) * 100) / 100, h = Math.round((p.height * 72 / 150) * 100) / 100;
    const content = `q ${w} 0 0 ${h} 0 0 cm /Im0 Do Q`;
    obj(pageN, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] /Resources << /XObject << /Im0 ${imgN} 0 R >> >> /Contents ${contN} 0 R >>`);
    obj(contN, `<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
    obj(imgN, [`<< /Type /XObject /Subtype /Image /Width ${p.width} /Height ${p.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${p.jpeg.length} >>\nstream\n`, Buffer.from(p.jpeg), '\nendstream']);
  });
  const xref = size;
  const count = 4 + n * 3;
  let x = `xref\n0 ${count}\n0000000000 65535 f \n`;
  for (let i = 1; i < count; i++) x += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  push(x);
  push(`trailer\n<< /Size ${count} /Root 1 0 R /Info 3 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return Buffer.concat(parts);
}

module.exports = { makePdf };
