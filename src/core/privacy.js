'use strict';
// Privacy check for photos: finds GPS positions, camera and lens serial numbers, owner names and unique IDs in the
// EXIF and XMP of HEIC, HEIF, AVIF and JPEG files, and removes them in place. "In place" means inside the same bytes:
// the metadata blocks keep their length, so the image data and every offset in the file stay where they were.
const { parseContainer, itemData, exifTiff } = require('./isobmff');
const X = require('./exif');

const PRIVACY_RE = /\.(heic|heif|hif|avif|jpe?g)$/i;

/** EXIF TIFF blocks and XMP blocks of a JPEG: [{ kind, start, end }] (byte ranges in the file). */
function jpegBlocks(b) {
  const out = [];
  if (b[0] !== 0xff || b[1] !== 0xd8) throw new Error('This is not a JPEG file.');
  let o = 2;
  while (o + 4 <= b.length && b[o] === 0xff) {
    const m = b[o + 1];
    if (m === 0xd8 || (m >= 0xd0 && m <= 0xd7) || m === 0x01) { o += 2; continue; }
    const len = (b[o + 2] << 8) | b[o + 3];
    if (m === 0xda || len < 2) break;
    const start = o + 4, end = o + 2 + len;
    if (m === 0xe1) {
      const head = Buffer.from(b.subarray(start, Math.min(end, start + 40))).toString('latin1');
      if (head.startsWith('Exif\0')) out.push({ kind: 'exif', start: start + 6, end });
      else if (head.startsWith('http://ns.adobe.com/xap/1.0/\0')) out.push({ kind: 'xmp', start: start + 29, end });
    }
    o = end;
  }
  return out;
}

/** EXIF and XMP blocks of a HEIF or AVIF file as byte ranges; blocks split over several extents are listed as split. */
function heifBlocks(b) {
  const c = parseContainer(b);
  const out = [];
  for (const e of c.exif) {
    const item = c.items.find((x) => x.id === e.id);
    const t = item && exifTiff(b, item);
    if (!t) continue;
    if (t.fileOffset >= 0) out.push({ kind: 'exif', start: t.fileOffset, end: t.fileOffset + t.tiff.length });
    else out.push({ kind: 'exif', split: true, data: t.tiff });
  }
  for (const x of c.xmp) {
    const item = c.items.find((i) => i.id === x.id);
    if (item && item.extents.length === 1) out.push({ kind: 'xmp', start: item.extents[0].offset, end: item.extents[0].offset + item.extents[0].length });
    else if (item) out.push({ kind: 'xmp', split: true, data: itemData(b, item) || new Uint8Array(0) });
  }
  return out;
}

function blocksOf(b, name) {
  return /\.jpe?g$/i.test(name) || (b[0] === 0xff && b[1] === 0xd8) ? jpegBlocks(b) : heifBlocks(b);
}

/**
 * Scans one file. Returns { findings: [{ kind, label, value }], camera, taken, canClean, error }.
 * findings is empty when nothing private is in the file.
 */
function scan(bytes, name) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  try {
    const blocks = blocksOf(b, name);
    const findings = [];
    let camera = '', taken = '';
    let split = false;
    for (const k of blocks) {
      const data = k.split ? k.data : b.subarray(k.start, k.end);
      if (k.split) split = true;
      if (k.kind === 'exif') {
        const ex = X.readExif(data);
        if (!ex) continue;
        findings.push(...X.privacyFindings(ex));
        const sum = Object.fromEntries(X.summary(ex));
        camera = camera || sum.Camera || '';
        taken = taken || sum.Taken || '';
      } else {
        for (const n of X.xmpFindings(Buffer.from(data).toString('latin1'))) findings.push({ kind: /GPS|Location|City|State|Country/.test(n) ? 'gps' : 'serial', label: `XMP ${n}`, value: 'present' });
      }
    }
    return { findings, camera, taken, canClean: !split, error: '' };
  } catch (e) {
    return { findings: [], camera: '', taken: '', canClean: false, error: String((e && e.message) || e) };
  }
}

/** Returns a cleaned copy of the file bytes and what was removed: { bytes, removed: [labels] }. Same length as input. */
function clean(bytes, name) {
  const b = Buffer.from(bytes);
  const removed = [];
  for (const k of blocksOf(b, name)) {
    if (k.split) throw new Error('The metadata of this file is split into several pieces, so it cannot be cleaned in place.');
    const view = b.subarray(k.start, k.end);
    if (k.kind === 'exif') removed.push(...X.stripTiff(view).removed);
    else removed.push(...X.stripXmp(view).map((n) => `XMP ${n}`));
  }
  return { bytes: b, removed };
}

module.exports = { scan, clean, PRIVACY_RE, jpegBlocks, heifBlocks };
