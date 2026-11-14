'use strict';
// Core tests: container parser (on our fixtures and on a HEIF built here box by box), EXIF reader, in-place privacy
// cleaner, EXIF embedding in JPEG, PNG and WebP, the PDF writer and the libheif decoder worker.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { parseContainer, itemData, exifTiff } = require('../src/core/isobmff');
const X = require('../src/core/exif');
const { openImage, describe } = require('../src/core/heif');
const embed = require('../src/core/embed');
const privacy = require('../src/core/privacy');
const { makePdf } = require('../src/core/pdf');
const { createDecoder, friendly } = require('../src/core/decoder');
const { encodePng, decodePng } = require('../src/core/png');

const FIX = path.join(__dirname, 'fixtures');
const SAMPLES = path.join(__dirname, '..', 'samples');
const read = (f) => fs.readFileSync(path.join(FIX, f));

// ---------- a HEIF built by hand ----------
const u8 = (v) => Buffer.from([v]);
const u16 = (v) => { const b = Buffer.alloc(2); b.writeUInt16BE(v); return b; };
const u32 = (v) => { const b = Buffer.alloc(4); b.writeUInt32BE(v); return b; };
const box = (type, ...parts) => { const body = Buffer.concat(parts); return Buffer.concat([u32(8 + body.length), Buffer.from(type, 'latin1'), body]); };
const full = (type, v, flags, ...parts) => box(type, u8(v), Buffer.from([(flags >> 16) & 255, (flags >> 8) & 255, flags & 255]), ...parts);
const infe = (id, type, name = '', hidden = false) => full('infe', 2, hidden ? 1 : 0, u16(id), u16(0), Buffer.from(type, 'latin1'), Buffer.from(name + '\0', 'utf8'));
function tiffBlock() {
  // Big-endian TIFF: IFD0 { Make, Orientation=6, ExifIFD, GPSIFD }, Exif { BodySerialNumber, LensModel }, GPS { lat, lon }.
  const b = Buffer.alloc(400);
  b.write('MM', 0, 'latin1'); b.writeUInt16BE(42, 2); b.writeUInt32BE(8, 4);
  let o = 8;
  const entry = (at, tag, type, count, value) => { b.writeUInt16BE(tag, at); b.writeUInt16BE(type, at + 2); b.writeUInt32BE(count, at + 4); if (type === 3 && count === 1) b.writeUInt16BE(value, at + 8); else b.writeUInt32BE(value, at + 8); };
  // IFD0 at 8: 4 entries
  b.writeUInt16BE(4, o);
  entry(o + 2, 0x010f, 2, 5, 200); // Make -> "Zovo\0" at 200
  entry(o + 14, 0x0112, 3, 1, 6);
  entry(o + 26, 0x8769, 4, 1, 60);
  entry(o + 38, 0x8825, 4, 1, 120);
  b.writeUInt32BE(0, o + 50);
  b.write('Zovo\0', 200, 'latin1');
  // Exif IFD at 60: 2 entries
  b.writeUInt16BE(2, 60);
  entry(62, 0xa431, 2, 8, 210); b.write('SN-0042\0', 210, 'latin1');
  entry(74, 0xa434, 2, 9, 220); b.write('Lens 50\0\0', 220, 'latin1');
  b.writeUInt32BE(0, 86);
  // GPS IFD at 120: 4 entries
  b.writeUInt16BE(4, 120);
  entry(122, 0x0001, 2, 2, 0); b.write('N\0', 130, 'latin1');
  entry(134, 0x0002, 5, 3, 240);
  entry(146, 0x0003, 2, 2, 0); b.write('W\0', 154, 'latin1');
  entry(158, 0x0004, 5, 3, 264);
  b.writeUInt32BE(0, 170);
  const rat = (at, ...v) => v.forEach(([n, d], i) => { b.writeUInt32BE(n, at + i * 8); b.writeUInt32BE(d, at + i * 8 + 4); });
  rat(240, [48, 1], [51, 1], [3000, 100]);
  rat(264, [2, 1], [17, 1], [4000, 100]);
  return b.subarray(0, 300);
}
function buildHeif() {
  // Items: 1 hvc1 primary (rot 90), 2 hvc1 second image, 3 hvc1 thumbnail of 1, 4 hvc1 alpha of 1, 5 hidden tile,
  // 6 Exif of 1, 7 XMP mime of 1. Payload bytes are fake: only the container is under test.
  const tiff = tiffBlock();
  const exifPayload = Buffer.concat([u32(6), Buffer.from('Exif\0\0', 'latin1'), tiff]);
  const xmp = Buffer.from('<x:xmpmeta><rdf:Description exif:GPSLatitude="48,51.5N" aux:SerialNumber="123"/></x:xmpmeta>', 'latin1');
  const payloads = { 1: Buffer.alloc(10, 1), 2: Buffer.alloc(10, 2), 3: Buffer.alloc(10, 3), 4: Buffer.alloc(10, 4), 5: Buffer.alloc(10, 5), 6: exifPayload, 7: xmp };
  const ftyp = box('ftyp', Buffer.from('heic', 'latin1'), u32(0), Buffer.from('mif1heic', 'latin1'));
  const hvcC = box('hvcC', u8(1), u8(1), Buffer.alloc(10), u8(90), u16(0xf000), u8(0xfc), u8(0xfd), u8(0xf8), u8(0xf8), Buffer.alloc(4));
  const props = [
    full('ispe', 0, 0, u32(640), u32(480)), // 1
    hvcC, // 2
    box('irot', u8(1)), // 3 (90 degrees)
    full('ispe', 0, 0, u32(160), u32(120)), // 4
    full('auxC', 0, 0, Buffer.from('urn:mpeg:hevc:2015:auxid:1\0', 'latin1')), // 5
    box('colr', Buffer.from('nclx', 'latin1'), u16(12), u16(13), u16(1), u8(0x80)), // 6 Display P3
  ];
  const ipco = box('ipco', ...props);
  const assoc = (id, idx) => Buffer.concat([u16(id), u8(idx.length), ...idx.map((i) => u8(i))]);
  const ipma = full('ipma', 0, 0, u32(5), assoc(1, [1, 2, 3, 6]), assoc(2, [1, 2]), assoc(3, [4, 2]), assoc(4, [1, 2, 5]), assoc(5, [1, 2]));
  const iinf = full('iinf', 0, 0, u16(7), infe(1, 'hvc1'), infe(2, 'hvc1'), infe(3, 'hvc1'), infe(4, 'hvc1'), infe(5, 'hvc1', '', true), infe(6, 'Exif'), full('infe', 2, 0, u16(7), u16(0), Buffer.from('mime', 'latin1'), Buffer.from('\0application/rdf+xml\0', 'latin1')));
  const ref = (type, from, ...to) => box(type, u16(from), u16(to.length), ...to.map(u16));
  const iref = full('iref', 0, 0, ref('thmb', 3, 1), ref('auxl', 4, 1), ref('cdsc', 6, 1), ref('cdsc', 7, 1));
  const ids = [1, 2, 3, 4, 5, 6, 7];
  const ilocLen = (ids2) => 4 + 2 + 2 + ids2.length * (2 + 2 + 2 + 4 + 4);
  const head = (iloc) => Buffer.concat([ftyp]);
  // Build iloc with placeholder offsets, then fix them once the meta size is known.
  const mk = (offs) => full('iloc', 0, 0, u8(0x44), u8(0x00), u16(ids.length), ...ids.map((id) => Buffer.concat([u16(id), u16(0), u16(1), u32(offs[id]), u32(payloads[id].length)])));
  const metaOf = (iloc) => full('meta', 0, 0, full('hdlr', 0, 0, u32(0), Buffer.from('pict', 'latin1'), Buffer.alloc(12), u8(0)), full('pitm', 0, 0, u16(1)), iloc, iinf, iref, box('iprp', ipco, ipma));
  let offs = Object.fromEntries(ids.map((id) => [id, 0]));
  const metaSize = metaOf(mk(offs)).length;
  let at = ftyp.length + metaSize + 8;
  for (const id of ids) { offs[id] = at; at += payloads[id].length; }
  const meta = metaOf(mk(offs));
  const mdat = box('mdat', ...ids.map((id) => payloads[id]));
  void ilocLen; void head;
  return { buf: Buffer.concat([ftyp, meta, mdat]), tiffOffset: offs[6] + 10, tiffLength: tiff.length };
}

test('container: hand-built HEIF lists 2 top-level images, primary first, thumbnail, alpha, rotation, P3, EXIF, XMP', () => {
  const { buf } = buildHeif();
  const c = parseContainer(buf);
  assert.equal(c.brand, 'heic');
  assert.equal(c.kind, 'heic');
  assert.deepEqual(c.images.map((i) => i.id), [1, 2]);
  const p = c.images[0];
  assert.equal(p.primary, true);
  assert.deepEqual([p.width, p.height, p.rotation, p.display.width, p.display.height], [640, 480, 90, 480, 640]);
  assert.deepEqual(p.thumbnails, ['160 x 120']);
  assert.equal(p.alpha, true);
  assert.equal(p.color.p3, true);
  assert.equal(p.color.transfer, 'sRGB');
  assert.equal(p.profile, 'Main');
  assert.deepEqual(p.exifIds, [6]);
  assert.equal(c.items.find((i) => i.id === 5).hidden, true);
  assert.equal(c.xmp.length, 1);
});
test('container: EXIF item gives the TIFF block and its file offset', () => {
  const { buf, tiffOffset } = buildHeif();
  const c = parseContainer(buf);
  const t = exifTiff(buf, c.items.find((i) => i.id === 6));
  assert.equal(t.fileOffset, tiffOffset);
  assert.equal(Buffer.from(t.tiff.subarray(0, 4)).toString('latin1'), 'MM\0*');
});
test('container: plain-language errors for non-HEIF data', () => {
  assert.throws(() => parseContainer(Buffer.from('not an image at all, just text')), /ftyp|HEIC/);
  assert.throws(() => parseContainer(Buffer.alloc(4)), /too short/);
  const broken = Buffer.concat([u32(20), Buffer.from('ftypheic', 'latin1'), u32(0), Buffer.from('mif1', 'latin1'), u32(9999), Buffer.from('meta', 'latin1')]);
  assert.throws(() => parseContainer(broken), /"meta" box at byte 20 says it is 9999 bytes/);
});
test('container: fixtures made by the macOS encoder (HEIC with irot from EXIF orientation 6, AVIF)', () => {
  const rot = parseContainer(read('quad-rot6.heic'));
  assert.deepEqual([rot.images[0].rotation, rot.images[0].display.width, rot.images[0].display.height], [270, 48, 64]);
  const avif = parseContainer(read('quad.avif'));
  assert.equal(avif.kind, 'avif');
  assert.equal(avif.images[0].type, 'av01');
  assert.equal(avif.images[0].bitDepth, 8);
});
test('container: the shipped samples are a 1600 x 1066 grid HEIC and AVIF with EXIF', () => {
  for (const f of ['sample-wind-farm.heic', 'sample-wind-farm.avif']) {
    const c = parseContainer(fs.readFileSync(path.join(SAMPLES, f)));
    assert.equal(c.images.length, 1, f);
    assert.equal(c.images[0].type, 'grid', f);
    assert.deepEqual([c.images[0].display.width, c.images[0].display.height], [1600, 1066], f);
    assert.equal(c.exif.length, 1, f);
  }
});

// ---------- EXIF ----------
test('exif: reads IFD0, Exif and GPS of the hand-built block; GPS as signed decimal numbers', () => {
  const ex = X.readExif(tiffBlock());
  const g = X.gpsOf(ex);
  assert.equal(g.lat, 48.8583333);
  assert.equal(g.lon, -2.2944444);
  assert.match(g.latText, /^48° 51' 30\.00" N$/);
  assert.match(g.lonText, /W$/);
  const sum = Object.fromEntries(X.summary(ex));
  assert.equal(sum.Camera, 'Zovo');
  assert.equal(sum.Lens, 'Lens 50');
  assert.match(sum['EXIF orientation'], /^6 /);
  assert.deepEqual(X.privacyFindings(ex).map((f) => f.kind), ['gps', 'serial']);
});
test('exif: stripTiff removes GPS and the serial number in place and keeps the rest readable', () => {
  const t = Buffer.from(tiffBlock());
  const len = t.length;
  const r = X.stripTiff(t);
  assert.equal(t.length, len);
  assert.deepEqual(r.removed, ['GPS (4 tags)', 'Camera serial number']);
  const ex = X.readExif(t);
  assert.equal(ex.gps, null);
  assert.equal(X.privacyFindings(ex).length, 0);
  assert.equal(Object.fromEntries(X.summary(ex)).Lens, 'Lens 50');
  assert.equal(Object.fromEntries(X.summary(ex)).Camera, 'Zovo');
  assert.equal(t.indexOf(Buffer.from('SN-0042')), -1);
});
test('exif: setOrientation writes 1 in place', () => {
  const t = Buffer.from(tiffBlock());
  assert.equal(X.setOrientation(t, 1), true);
  assert.match(Object.fromEntries(X.summary(X.readExif(t)))['EXIF orientation'], /^1 /);
  assert.equal(X.setOrientation(t, 1), false);
});
test('exif: little-endian blocks from a real JPEG (the test fixture) parse the same way', () => {
  const j = read('quad-rot6.jpg');
  const b = privacy.jpegBlocks(j).find((k) => k.kind === 'exif');
  const ex = X.readExif(j.subarray(b.start, b.end));
  const g = X.gpsOf(ex);
  assert.deepEqual([g.lat, g.lon], [-33.865, -70.5]);
  assert.deepEqual(X.privacyFindings(ex).map((f) => f.label).sort(), ['Camera owner name', 'Camera serial number', 'GPS position']);
});
test('exif: XMP findings and in-place blanking keep the length', () => {
  const x = Buffer.from('<rdf:Description exif:GPSLatitude="48,51.5N" exif:GPSLongitude="2,17.6667W" aux:SerialNumber="123" tiff:Make="Zovo"><exif:GPSAltitude>35/1</exif:GPSAltitude></rdf:Description>', 'latin1');
  assert.deepEqual(X.xmpFindings(x.toString('latin1')), ['exif:GPSLatitude', 'exif:GPSLongitude', 'aux:SerialNumber', 'exif:GPSAltitude']);
  const s = X.xmpSummary(x.toString('latin1'));
  assert.deepEqual([s.gps.lat, s.gps.lon], [48.8583333, -2.294445]);
  const copy = Buffer.from(x);
  X.stripXmp(copy);
  assert.equal(copy.length, x.length);
  assert.deepEqual(X.xmpFindings(copy.toString('latin1')), []);
  assert.match(copy.toString('latin1'), /tiff:Make="Zovo"/);
});

// ---------- open + describe ----------
test('heif: describe() of the shipped HEIC sample: camera, made-up GPS, privacy findings, image rows', () => {
  const img = openImage(fs.readFileSync(path.join(SAMPLES, 'sample-wind-farm.heic')), 'sample-wind-farm.heic');
  const d = describe(img, img.primaryIndex);
  const cam = Object.fromEntries(d.camera);
  assert.equal(cam.Camera, 'NIKON Z 8');
  assert.equal(cam.Exposure, '1/640 s');
  assert.equal(cam.Aperture, 'f/10');
  assert.deepEqual([d.gps.lat, d.gps.lon, d.gps.alt], [52.3751389, 9.7367361, 61]);
  assert.deepEqual(d.privacy.map((p) => p.label), ['GPS position', 'Camera serial number']);
  assert.ok(d.image.some(([k, v]) => k === 'Grid' && /tiles of 512 x 512/.test(v)));
  assert.ok(img.decodable(img.primaryIndex));
});
test('heif: an AVIF reports kind avif and its single image is decodable in the webview', () => {
  const img = openImage(read('quad.avif'), 'quad.avif');
  assert.equal(img.kind, 'avif');
  assert.equal(img.decodable(0), true);
});

// ---------- privacy (files) ----------
test('privacy: scan and clean a HEIC in place; image data bytes stay identical', () => {
  const src = read('quad-rot6.heic');
  const s = privacy.scan(src, 'quad-rot6.heic');
  assert.deepEqual(s.findings.map((f) => f.kind).sort(), ['gps', 'owner', 'serial']);
  const r = privacy.clean(src, 'quad-rot6.heic');
  assert.equal(r.bytes.length, src.length);
  assert.ok(r.removed.includes('Camera owner name'));
  assert.equal(privacy.scan(r.bytes, 'x.heic').findings.length, 0);
  // Only bytes inside the EXIF block changed.
  const blk = privacy.heifBlocks(src).find((b) => b.kind === 'exif');
  for (let i = 0; i < src.length; i++) if (i < blk.start || i >= blk.end) assert.equal(r.bytes[i], src[i], `byte ${i} outside the EXIF block changed`);
});
test('privacy: a JPEG is cleaned in place too; a file without findings reports none', () => {
  const j = read('quad-rot6.jpg');
  const r = privacy.clean(j, 'q.jpg');
  assert.equal(r.bytes.length, j.length);
  assert.equal(privacy.scan(r.bytes, 'q.jpg').findings.length, 0);
  assert.equal(privacy.scan(r.bytes, 'q.jpg').camera, 'Zovo Test pattern');
  const none = privacy.scan(Buffer.from('not a photo'), 'x.heic');
  assert.match(none.error, /ftyp|HEIC/);
});

// ---------- embedding EXIF into converted files ----------
test('embed: PNG gets an eXIf chunk with a valid CRC; orientation reset to 1; GPS removed in nogps mode', () => {
  const png = encodePng(4, 3, new Uint8Array(4 * 3 * 4).fill(128));
  const tiff = embed.exifForOutput(tiffBlock(), 'nogps');
  const out = embed.withExif('png', png, tiff, 4, 3);
  const back = embed.readBackExif(out);
  const ex = X.readExif(back);
  assert.equal(X.gpsOf(ex), null);
  assert.match(Object.fromEntries(X.summary(ex))['EXIF orientation'], /^1 /);
  assert.deepEqual([decodePng(out).width, decodePng(out).height], [4, 3]);
  // CRC check of the eXIf chunk
  const at = out.indexOf(Buffer.from('eXIf'));
  const len = out.readUInt32BE(at - 4);
  assert.equal(out.readUInt32BE(at + 4 + len), embed.crc32(out.subarray(at, at + 4 + len)));
});
test('embed: JPEG gets an APP1 Exif segment after JFIF; keep mode keeps GPS; none mode writes nothing', () => {
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16]), Buffer.from('JFIF\0', 'latin1'), Buffer.alloc(9), Buffer.from([0xff, 0xda, 0, 2, 0xff, 0xd9])]);
  const out = embed.withExif('jpeg', jpeg, embed.exifForOutput(tiffBlock(), 'keep'));
  assert.equal(out.indexOf(Buffer.from('JFIF')), 6);
  const ex = X.readExif(embed.readBackExif(out));
  assert.equal(X.gpsOf(ex).lat, 48.8583333);
  assert.equal(embed.exifForOutput(tiffBlock(), 'none'), null);
  assert.deepEqual(embed.withExif('jpeg', jpeg, null), jpeg);
});
test('embed: a simple VP8L WebP becomes VP8X with an EXIF chunk and a correct RIFF size', () => {
  const vp8l = Buffer.from([0x2f, 0x03, 0x40, 0x00, 0x10, 0, 0, 0, 0]);
  const webp = Buffer.concat([Buffer.from('RIFF', 'latin1'), Buffer.from([4 + 8 + 10, 0, 0, 0]), Buffer.from('WEBPVP8L', 'latin1'), Buffer.from([9, 0, 0, 0]), vp8l, Buffer.from([0])]);
  const out = embed.withExif('webp', webp, tiffBlock(), 4, 2);
  assert.equal(out.toString('latin1', 12, 16), 'VP8X');
  assert.equal(out[20] & 0x08, 0x08);
  assert.equal(out[20] & 0x10, 0x10);
  assert.equal(out.readUIntLE(24, 3), 3);
  assert.equal(out.readUInt32LE(4), out.length - 8);
  assert.ok(embed.readBackExif(out));
});

// ---------- PDF ----------
test('pdf: one page per JPEG, xref offsets point at the objects', () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  const pdf = makePdf([{ jpeg, width: 1240, height: 1754 }, { jpeg, width: 1240, height: 1754 }], 'Sheet (test)');
  const s = pdf.toString('latin1');
  assert.match(s, /^%PDF-1\.4/);
  assert.match(s, /\/Count 2/);
  assert.match(s, /\/MediaBox \[0 0 595\.2 841\.92\]/);
  const xref = Number(/startxref\n(\d+)/.exec(s)[1]);
  assert.equal(s.slice(xref, xref + 4), 'xref');
  const offs = [...s.slice(xref).matchAll(/^(\d{10}) 00000 n $/gm)].map((m) => Number(m[1]));
  offs.forEach((o, i) => assert.equal(s.slice(o, o + `${i + 1} 0 obj`.length), `${i + 1} 0 obj`));
});

// ---------- decoder worker (libheif) ----------
test('decoder: the HEIC fixture decodes to its four colored quarters', async () => {
  const d = createDecoder({ idleMs: 200 });
  const r = await d.decodeHeic({ bytes: read('quad.heic') });
  assert.deepEqual([r.width, r.height, r.count], [64, 48, 1]);
  const px = (x, y) => Array.from(r.rgba.subarray((y * 64 + x) * 4, (y * 64 + x) * 4 + 4));
  const near = (a, b) => a.every((v, i) => Math.abs(v - b[i]) <= 12);
  assert.ok(near(px(8, 8), [230, 30, 30, 255]), String(px(8, 8)));
  assert.ok(near(px(56, 8), [30, 200, 40, 255]), String(px(56, 8)));
  assert.ok(near(px(8, 40), [30, 60, 230, 255]), String(px(8, 40)));
  assert.ok(near(px(56, 40), [240, 240, 240, 255]), String(px(56, 40)));
  d.stop();
});
test('decoder: the rotation is applied (48 x 64) and maxSide shrinks the result', async () => {
  const d = createDecoder({ idleMs: 200 });
  const r = await d.decodeHeic({ bytes: read('quad-rot6.heic') });
  assert.deepEqual([r.width, r.height], [48, 64]);
  const small = await d.decodeHeic({ bytes: fs.readFileSync(path.join(SAMPLES, 'sample-wind-farm.heic')), maxSide: 200 });
  assert.deepEqual([small.width, small.height], [200, 133]);
  d.stop();
});
test('decoder: an AVIF or a broken file resolves with a readable error, never throws; the worker ends when idle', async () => {
  const d = createDecoder({ idleMs: 50 });
  const a = await d.decodeHeic({ bytes: read('quad.avif') });
  assert.match(a.error, /AV1|avif/i);
  const b = await d.decodeHeic({ bytes: Buffer.from('garbage bytes, no HEIF here') });
  assert.ok(b.error && b.error.length > 5, String(b.error));
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(d.running, false);
  assert.match(friendly('Support for this compression format has not been built in: VVC'), /VVC/);
});
