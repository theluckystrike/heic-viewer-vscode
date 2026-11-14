'use strict';
// EXIF (TIFF) reader and in-place privacy cleaner. Pure JavaScript.
// readExif(tiff) lists IFD0, the Exif IFD, the GPS IFD and IFD1 with names and values. summary() picks the camera
// fields the viewer shows. privacyFindings() names GPS, serial numbers and owner names. stripTiff() removes those
// tags inside the same bytes (same length, so the file around it never moves): it drops the IFD entries, zeros their
// values and leaves a valid TIFF. setOrientation() writes the Orientation tag in place.

const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8, 13: 4 };

const TAGS = {
  ifd0: {
    0x010e: 'ImageDescription', 0x010f: 'Make', 0x0110: 'Model', 0x0112: 'Orientation', 0x011a: 'XResolution', 0x011b: 'YResolution',
    0x0128: 'ResolutionUnit', 0x0131: 'Software', 0x0132: 'DateTime', 0x013b: 'Artist', 0x013c: 'HostComputer', 0x0213: 'YCbCrPositioning',
    0x8298: 'Copyright', 0x8769: 'ExifIFD', 0x8825: 'GPSIFD', 0x0201: 'ThumbnailOffset', 0x0202: 'ThumbnailLength', 0x0103: 'Compression',
    0x0100: 'ImageWidth', 0x0101: 'ImageHeight', 0xc4a5: 'PrintIM', 0x9c9b: 'XPTitle', 0x9c9c: 'XPComment', 0x9c9d: 'XPAuthor', 0x9c9e: 'XPKeywords', 0x9c9f: 'XPSubject',
  },
  exif: {
    0x829a: 'ExposureTime', 0x829d: 'FNumber', 0x8822: 'ExposureProgram', 0x8827: 'ISO', 0x8830: 'SensitivityType', 0x9000: 'ExifVersion',
    0x9003: 'DateTimeOriginal', 0x9004: 'DateTimeDigitized', 0x9010: 'OffsetTime', 0x9011: 'OffsetTimeOriginal', 0x9012: 'OffsetTimeDigitized',
    0x9101: 'ComponentsConfiguration', 0x9201: 'ShutterSpeedValue', 0x9202: 'ApertureValue', 0x9203: 'BrightnessValue', 0x9204: 'ExposureBiasValue',
    0x9205: 'MaxApertureValue', 0x9207: 'MeteringMode', 0x9209: 'Flash', 0x920a: 'FocalLength', 0x9214: 'SubjectArea', 0x927c: 'MakerNote',
    0x9286: 'UserComment', 0x9290: 'SubSecTime', 0x9291: 'SubSecTimeOriginal', 0x9292: 'SubSecTimeDigitized', 0xa000: 'FlashpixVersion', 0xa001: 'ColorSpace',
    0xa002: 'PixelXDimension', 0xa003: 'PixelYDimension', 0xa005: 'InteropIFD', 0xa217: 'SensingMethod', 0xa300: 'FileSource', 0xa301: 'SceneType',
    0xa401: 'CustomRendered', 0xa402: 'ExposureMode', 0xa403: 'WhiteBalance', 0xa404: 'DigitalZoomRatio', 0xa405: 'FocalLengthIn35mmFilm',
    0xa406: 'SceneCaptureType', 0xa420: 'ImageUniqueID', 0xa430: 'CameraOwnerName', 0xa431: 'BodySerialNumber', 0xa432: 'LensSpecification',
    0xa433: 'LensMake', 0xa434: 'LensModel', 0xa435: 'LensSerialNumber', 0xa460: 'CompositeImage', 0x8832: 'RecommendedExposureIndex',
  },
  gps: {
    0x00: 'GPSVersionID', 0x01: 'GPSLatitudeRef', 0x02: 'GPSLatitude', 0x03: 'GPSLongitudeRef', 0x04: 'GPSLongitude', 0x05: 'GPSAltitudeRef',
    0x06: 'GPSAltitude', 0x07: 'GPSTimeStamp', 0x0c: 'GPSSpeedRef', 0x0d: 'GPSSpeed', 0x0e: 'GPSTrackRef', 0x0f: 'GPSTrack', 0x10: 'GPSImgDirectionRef',
    0x11: 'GPSImgDirection', 0x12: 'GPSMapDatum', 0x17: 'GPSDestBearingRef', 0x18: 'GPSDestBearing', 0x1d: 'GPSDateStamp', 0x1f: 'GPSHPositioningError',
  },
  interop: { 0x0001: 'InteropIndex', 0x0002: 'InteropVersion' },
};
TAGS.ifd1 = TAGS.ifd0;

/** Tags that tell who or where: removed by the privacy cleaner. GPS IFD goes as a whole. */
const PRIVATE_EXIF = { 0xa430: 'Camera owner name', 0xa431: 'Camera serial number', 0xa435: 'Lens serial number', 0xa420: 'Unique image ID' };
const PRIVATE_IFD0 = { 0x013b: 'Artist', 0x9c9d: 'Author (Windows)', 0x013c: 'Device name' };

const ORIENTATION = { 1: 'Normal', 2: 'Mirrored left-right', 3: 'Rotated 180°', 4: 'Mirrored top-bottom', 5: 'Mirrored and rotated 90° CCW', 6: 'Rotated 90° CW', 7: 'Mirrored and rotated 90° CW', 8: 'Rotated 90° CCW' };
const EXPOSURE_PROGRAM = { 0: 'Not set', 1: 'Manual', 2: 'Program', 3: 'Aperture priority', 4: 'Shutter priority', 5: 'Creative', 6: 'Action', 7: 'Portrait', 8: 'Landscape' };
const METERING = { 0: 'Unknown', 1: 'Average', 2: 'Center-weighted', 3: 'Spot', 4: 'Multi-spot', 5: 'Pattern', 6: 'Partial', 255: 'Other' };
const WHITE_BALANCE = { 0: 'Auto', 1: 'Manual' };

function view(tiff) {
  if (!tiff || tiff.length < 8) return null;
  const le = tiff[0] === 0x49 && tiff[1] === 0x49;
  const be = tiff[0] === 0x4d && tiff[1] === 0x4d;
  if (!le && !be) return null;
  const dv = new DataView(tiff.buffer, tiff.byteOffset, tiff.byteLength);
  const v = {
    le, len: tiff.length, tiff, dv,
    u16: (o) => dv.getUint16(o, le), u32: (o) => dv.getUint32(o, le), i32: (o) => dv.getInt32(o, le),
    set16: (o, x) => dv.setUint16(o, x, le), set32: (o, x) => dv.setUint32(o, x, le),
  };
  if (v.u16(2) !== 42) return null;
  return v;
}

function readValue(v, type, count, at) {
  const size = TYPE_SIZE[type] || 1;
  const n = Math.min(count, 65536);
  if (at < 0 || at + size * n > v.len) return undefined;
  const arr = [];
  for (let i = 0; i < n; i++) {
    const o = at + i * size;
    switch (type) {
      case 1: case 7: arr.push(v.tiff[o]); break;
      case 6: arr.push((v.tiff[o] << 24) >> 24); break;
      case 2: arr.push(v.tiff[o]); break;
      case 3: arr.push(v.u16(o)); break;
      case 8: arr.push((v.u16(o) << 16) >> 16); break;
      case 4: case 13: arr.push(v.u32(o)); break;
      case 9: arr.push(v.i32(o)); break;
      case 5: { const a = v.u32(o), b = v.u32(o + 4); arr.push(b ? a / b : 0); break; }
      case 10: { const a = v.i32(o), b = v.i32(o + 4); arr.push(b ? a / b : 0); break; }
      case 11: arr.push(v.dv.getFloat32(o, v.le)); break;
      case 12: arr.push(v.dv.getFloat64(o, v.le)); break;
      default: arr.push(v.tiff[o]);
    }
  }
  if (type === 2) return Buffer.from(arr).toString('utf8').replace(/\0[\s\S]*$/, '').trim();
  if (type === 7 && n > 4) return { bytes: n };
  return n === 1 ? arr[0] : arr;
}

/** Reads one IFD: { offset, entries: [{ tag, name, type, count, valueAt, size, entryAt, value }], next }. */
function readIfd(v, off, table) {
  if (!off || off + 2 > v.len) return null;
  const n = v.u16(off);
  if (off + 2 + n * 12 + 4 > v.len || n > 1000) return null;
  const entries = [];
  for (let i = 0; i < n; i++) {
    const e = off + 2 + i * 12;
    const tag = v.u16(e), type = v.u16(e + 2), count = v.u32(e + 4);
    const size = (TYPE_SIZE[type] || 1) * count;
    const valueAt = size <= 4 ? e + 8 : v.u32(e + 8);
    entries.push({ tag, name: table[tag] || `Tag 0x${tag.toString(16).padStart(4, '0')}`, type, count, size, valueAt, entryAt: e, value: readValue(v, type, count, valueAt) });
  }
  return { offset: off, count: n, entries, next: v.u32(off + 2 + n * 12) };
}

/** All IFDs of an EXIF TIFF block, or null when the bytes are not TIFF. */
function readExif(tiff) {
  const v = view(tiff);
  if (!v) return null;
  const out = { le: v.le, ifd0: null, exif: null, gps: null, interop: null, ifd1: null };
  out.ifd0 = readIfd(v, v.u32(4), TAGS.ifd0);
  if (!out.ifd0) return out;
  const ptr = (ifd, tag) => { const e = ifd && ifd.entries.find((x) => x.tag === tag); return e && typeof e.value === 'number' ? e.value : 0; };
  out.exif = readIfd(v, ptr(out.ifd0, 0x8769), TAGS.exif);
  out.gps = readIfd(v, ptr(out.ifd0, 0x8825), TAGS.gps);
  out.interop = readIfd(v, ptr(out.exif, 0xa005), TAGS.interop);
  if (out.ifd0.next && out.ifd0.next !== out.ifd0.offset) out.ifd1 = readIfd(v, out.ifd0.next, TAGS.ifd1);
  return out;
}

const fieldOf = (ex, ifd, name) => { const d = ex && ex[ifd]; const e = d && d.entries.find((x) => x.name === name); return e ? e.value : undefined; };

function dmsToDeg(v, ref) {
  if (!Array.isArray(v) || v.length < 1) return undefined;
  const d = (v[0] || 0) + (v[1] || 0) / 60 + (v[2] || 0) / 3600;
  return /^[SW]/i.test(String(ref || '')) ? -d : d;
}
function fmtDms(deg, pos, neg) {
  const a = Math.abs(deg);
  const d = Math.floor(a), mf = (a - d) * 60, m = Math.floor(mf), s = (mf - m) * 60;
  return `${d}° ${m}' ${s.toFixed(2)}" ${deg < 0 ? neg : pos}`;
}

/** GPS as numbers: { lat, lon, alt, latText, lonText, time, direction } or null when there is no position. */
function gpsOf(ex) {
  if (!ex || !ex.gps) return null;
  const lat = dmsToDeg(fieldOf(ex, 'gps', 'GPSLatitude'), fieldOf(ex, 'gps', 'GPSLatitudeRef'));
  const lon = dmsToDeg(fieldOf(ex, 'gps', 'GPSLongitude'), fieldOf(ex, 'gps', 'GPSLongitudeRef'));
  if (typeof lat !== 'number' || typeof lon !== 'number' || !isFinite(lat) || !isFinite(lon)) return null;
  const altV = fieldOf(ex, 'gps', 'GPSAltitude');
  const altRef = fieldOf(ex, 'gps', 'GPSAltitudeRef');
  const below = altRef === 1 || (Array.isArray(altRef) && altRef[0] === 1);
  const alt = typeof altV === 'number' ? (below ? -altV : altV) : undefined;
  const ts = fieldOf(ex, 'gps', 'GPSTimeStamp'), ds = fieldOf(ex, 'gps', 'GPSDateStamp');
  const time = Array.isArray(ts) && ts.length === 3 ? `${ds ? ds.replace(/:/g, '-') + ' ' : ''}${ts.map((x, i) => (i < 2 ? String(Math.floor(x)).padStart(2, '0') : x.toFixed(0).padStart(2, '0'))).join(':')} UTC` : '';
  const dir = fieldOf(ex, 'gps', 'GPSImgDirection');
  return {
    lat: Math.round(lat * 1e7) / 1e7, lon: Math.round(lon * 1e7) / 1e7, alt: typeof alt === 'number' ? Math.round(alt * 10) / 10 : undefined,
    latText: fmtDms(lat, 'N', 'S'), lonText: fmtDms(lon, 'E', 'W'), time, direction: typeof dir === 'number' ? Math.round(dir * 10) / 10 : undefined,
  };
}

function exposureText(t) {
  if (typeof t !== 'number' || !(t > 0)) return '';
  if (t >= 1) return `${Math.round(t * 10) / 10} s`;
  return `1/${Math.round(1 / t)} s`;
}

/** The camera fields the info panel shows, as [label, text] pairs, only those present. */
function summary(ex) {
  if (!ex) return [];
  const f = (ifd, n) => fieldOf(ex, ifd, n);
  const rows = [];
  const add = (k, v) => { if (v !== undefined && v !== null && v !== '' && !(typeof v === 'number' && !isFinite(v))) rows.push([k, String(v)]); };
  const make = f('ifd0', 'Make'), model = f('ifd0', 'Model');
  const cam = model ? (make && !String(model).toLowerCase().startsWith(String(make).split(' ')[0].toLowerCase()) ? `${make} ${model}` : String(model)) : make;
  add('Camera', cam || undefined);
  add('Lens', f('exif', 'LensModel') || undefined);
  const dto = f('exif', 'DateTimeOriginal') || f('ifd0', 'DateTime');
  const off = f('exif', 'OffsetTimeOriginal');
  add('Taken', dto ? `${String(dto).replace(/^(\d{4}):(\d{2}):(\d{2})/, '$1-$2-$3')}${off ? ` (UTC${off})` : ''}` : undefined);
  add('Exposure', exposureText(f('exif', 'ExposureTime')) || undefined);
  const fn = f('exif', 'FNumber');
  add('Aperture', typeof fn === 'number' && fn > 0 ? `f/${Math.round(fn * 10) / 10}` : undefined);
  const iso = f('exif', 'ISO');
  add('ISO', Array.isArray(iso) ? iso[0] : iso);
  const fl = f('exif', 'FocalLength'), fl35 = f('exif', 'FocalLengthIn35mmFilm');
  add('Focal length', typeof fl === 'number' ? `${Math.round(fl * 100) / 100} mm${fl35 ? ` (${fl35} mm in 35 mm terms)` : ''}` : undefined);
  const bias = f('exif', 'ExposureBiasValue');
  if (typeof bias === 'number' && bias !== 0) add('Exposure bias', `${bias > 0 ? '+' : ''}${Math.round(bias * 100) / 100} EV`);
  const flash = f('exif', 'Flash');
  if (typeof flash === 'number') add('Flash', flash & 1 ? 'Fired' : 'Did not fire');
  const prog = f('exif', 'ExposureProgram');
  if (typeof prog === 'number' && prog) add('Program', EXPOSURE_PROGRAM[prog] || prog);
  const met = f('exif', 'MeteringMode');
  if (typeof met === 'number' && met) add('Metering', METERING[met] || met);
  const wb = f('exif', 'WhiteBalance');
  if (typeof wb === 'number') add('White balance', WHITE_BALANCE[wb] || wb);
  const o = f('ifd0', 'Orientation');
  if (typeof o === 'number') add('EXIF orientation', `${o} (${ORIENTATION[o] || 'unknown'})`);
  add('Software', f('ifd0', 'Software') || undefined);
  add('Artist', f('ifd0', 'Artist') || undefined);
  add('Copyright', f('ifd0', 'Copyright') || undefined);
  add('Description', f('ifd0', 'ImageDescription') || undefined);
  return rows;
}

function display(v) {
  if (v === undefined) return '(unreadable)';
  if (v && typeof v === 'object' && !Array.isArray(v)) return `(${v.bytes} bytes)`;
  if (Array.isArray(v)) return v.length > 16 ? `(${v.length} values)` : v.map((x) => (typeof x === 'number' && !Number.isInteger(x) ? Math.round(x * 10000) / 10000 : x)).join(', ');
  if (typeof v === 'number' && !Number.isInteger(v)) return String(Math.round(v * 10000) / 10000);
  return String(v);
}

/** Every tag as { ifd, name, value } text rows, for the "All EXIF tags" list. */
function allTags(ex) {
  if (!ex) return [];
  const rows = [];
  for (const k of ['ifd0', 'exif', 'gps', 'interop', 'ifd1']) {
    const d = ex[k];
    if (!d) continue;
    for (const e of d.entries) {
      if (/^(ExifIFD|GPSIFD|InteropIFD)$/.test(e.name)) continue;
      rows.push({ ifd: k === 'ifd0' ? 'Image' : k === 'ifd1' ? 'Thumbnail' : k === 'exif' ? 'Exif' : k === 'gps' ? 'GPS' : 'Interop', name: e.name, value: display(e.value) });
    }
  }
  return rows;
}

/** What the privacy check reports: [{ kind: 'gps' | 'serial' | 'owner' | 'id', label, value }]. */
function privacyFindings(ex) {
  const out = [];
  if (!ex) return out;
  const g = gpsOf(ex);
  if (g) out.push({ kind: 'gps', label: 'GPS position', value: `${g.lat}, ${g.lon}${g.alt !== undefined ? `, ${g.alt} m` : ''}` });
  else if (ex.gps && ex.gps.entries.length) out.push({ kind: 'gps', label: 'GPS tags', value: `${ex.gps.entries.length} tags without a position` });
  for (const e of (ex.exif ? ex.exif.entries : [])) if (PRIVATE_EXIF[e.tag] && e.value !== '' && e.value !== undefined) out.push({ kind: e.tag === 0xa430 ? 'owner' : e.tag === 0xa420 ? 'id' : 'serial', label: PRIVATE_EXIF[e.tag], value: display(e.value) });
  for (const e of (ex.ifd0 ? ex.ifd0.entries : [])) if (PRIVATE_IFD0[e.tag] && e.value !== '' && e.value !== undefined) out.push({ kind: 'owner', label: PRIVATE_IFD0[e.tag], value: display(e.value) });
  return out;
}

/** Removes the entries for which drop(entry) is true from the IFD at `off`, in place: the remaining entries move up,
 *  the count and next pointer follow them, freed bytes and the dropped values become zero. Returns how many went. */
function compactIfd(v, ifd, drop) {
  const keep = ifd.entries.filter((e) => !drop(e));
  const gone = ifd.entries.filter((e) => drop(e));
  if (!gone.length) return 0;
  for (const e of gone) if (e.size > 4 && e.valueAt + e.size <= v.len) v.tiff.fill(0, e.valueAt, e.valueAt + e.size);
  const saved = keep.map((e) => Buffer.from(v.tiff.subarray(e.entryAt, e.entryAt + 12)));
  const base = ifd.offset;
  v.set16(base, keep.length);
  saved.forEach((b, i) => v.tiff.set(b, base + 2 + i * 12));
  v.set32(base + 2 + keep.length * 12, ifd.next);
  v.tiff.fill(0, base + 2 + keep.length * 12 + 4, base + 2 + ifd.count * 12 + 4);
  return gone.length;
}

/**
 * Removes GPS, serial numbers, owner names and the unique image ID from an EXIF TIFF block, in place.
 * opts: { gps: true, serials: true, owner: true }. Returns { removed: [labels] }. The block keeps its length.
 */
function stripTiff(tiff, opts = {}) {
  const o = { gps: true, serials: true, owner: true, ...opts };
  const v = view(tiff);
  if (!v) return { removed: [] };
  const ex = readExif(tiff);
  const removed = [];
  if (!ex || !ex.ifd0) return { removed };
  if (o.gps && ex.gps) {
    // Zero every GPS value and the GPS IFD itself, then drop the pointer from IFD0.
    for (const e of ex.gps.entries) if (e.size > 4 && e.valueAt + e.size <= v.len) v.tiff.fill(0, e.valueAt, e.valueAt + e.size);
    v.tiff.fill(0, ex.gps.offset, ex.gps.offset + 2 + ex.gps.count * 12 + 4);
    removed.push(`GPS (${ex.gps.entries.length} tags)`);
  }
  const ifd0Drop = (e) => (o.gps && e.tag === 0x8825) || (o.owner && PRIVATE_IFD0[e.tag]);
  for (const e of ex.ifd0.entries) if (o.owner && PRIVATE_IFD0[e.tag]) removed.push(PRIVATE_IFD0[e.tag]);
  compactIfd(v, ex.ifd0, ifd0Drop);
  if (ex.exif) {
    const drop = (e) => (o.serials && (e.tag === 0xa431 || e.tag === 0xa435 || e.tag === 0xa420)) || (o.owner && e.tag === 0xa430);
    for (const e of ex.exif.entries) if (drop(e)) removed.push(PRIVATE_EXIF[e.tag]);
    compactIfd(v, ex.exif, drop);
  }
  return { removed };
}

/** Sets the Orientation tag of IFD0 to `value` in place, when the tag exists. Returns true when it changed. */
function setOrientation(tiff, value) {
  const v = view(tiff);
  if (!v) return false;
  const ifd = readIfd(v, v.u32(4), TAGS.ifd0);
  const e = ifd && ifd.entries.find((x) => x.tag === 0x0112);
  if (!e || e.type !== 3) return false;
  if (e.value === value) return false;
  v.set16(e.entryAt + 8, value);
  return true;
}

// XMP: GPS and serial numbers can also sit in the XMP packet. Blank them with spaces (same length, still valid XML).
const XMP_PRIVATE = /(?:exif|exifEX|aux|Iptc4xmpCore|photoshop):(?:GPS[A-Za-z]*|SerialNumber|LensSerialNumber|BodySerialNumber|OwnerName|CameraOwnerName|ImageUniqueID|Location|City|State|Country|CreatorContactInfo)/;
function xmpFindings(text) {
  const out = [];
  const re = new RegExp(`(${XMP_PRIVATE.source})`, 'g');
  const seen = new Set();
  let m;
  while ((m = re.exec(text))) { const n = m[1]; if (!seen.has(n)) { seen.add(n); out.push(n); } }
  return out;
}
/** Blanks private XMP attributes and elements in place in a byte array. Returns the names removed. */
function stripXmp(bytes) {
  const text = Buffer.from(bytes).toString('latin1');
  const names = xmpFindings(text);
  if (!names.length) return [];
  const spaces = (s) => ' '.repeat(s.length);
  let t = text;
  const name = XMP_PRIVATE.source;
  t = t.replace(new RegExp(`\\s(${name})="[^"]*"`, 'g'), spaces);
  t = t.replace(new RegExp(`<(${name})\\b[^>]*/>`, 'g'), spaces);
  t = t.replace(new RegExp(`<(${name})\\b[^>]*>[\\s\\S]*?</\\1>`, 'g'), spaces);
  const out = Buffer.from(t, 'latin1');
  if (out.length === bytes.length) bytes.set(out);
  return names;
}


// ---------- XMP fallback (photos exported by Lightroom and others often carry only XMP) ----------
function xmpValue(text, names) {
  for (const n of names) {
    const esc = n.replace(':', '\\:');
    let m = new RegExp(`\\s${esc}="([^"]*)"`).exec(text);
    if (m) return m[1];
    m = new RegExp(`<${esc}>\\s*(?:<rdf:(?:Seq|Bag|Alt)>\\s*<rdf:li[^>]*>)?([^<]*)<`).exec(text);
    if (m && m[1].trim()) return m[1].trim();
  }
  return '';
}
const ratio = (v) => { const m = /^(-?\d+(?:\.\d+)?)(?:\/(\d+(?:\.\d+)?))?$/.exec(String(v).trim()); if (!m) return NaN; return m[2] ? Number(m[1]) / Number(m[2]) : Number(m[1]); };
function xmpCoord(v) {
  // "52,22.5083N" or "52,22,30.5N"
  const m = /^(\d+),(\d+(?:\.\d+)?)(?:,(\d+(?:\.\d+)?))?([NSEW])$/i.exec(String(v).trim());
  if (!m) return undefined;
  const d = Number(m[1]) + Number(m[2]) / 60 + (m[3] ? Number(m[3]) / 3600 : 0);
  return /[SW]/i.test(m[4]) ? -d : d;
}
/** Camera rows and GPS from an XMP packet, in the same shape as summary() and gpsOf(). */
function xmpSummary(text) {
  if (!text) return { rows: [], gps: null };
  const rows = [];
  const add = (k, v) => { if (v !== undefined && v !== '' && !(typeof v === 'number' && !isFinite(v))) rows.push([k, String(v)]); };
  const make = xmpValue(text, ['tiff:Make']), model = xmpValue(text, ['tiff:Model']);
  add('Camera', model ? (make && !model.toLowerCase().startsWith(make.split(' ')[0].toLowerCase()) ? `${make} ${model}` : model) : make);
  add('Lens', xmpValue(text, ['exifEX:LensModel', 'aux:Lens']));
  const taken = xmpValue(text, ['exif:DateTimeOriginal', 'photoshop:DateCreated', 'xmp:CreateDate']);
  if (taken) { const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}(?::\d{2})?)(?:\.\d+)?(Z|[+-]\d{2}:\d{2})?/.exec(taken); add('Taken', m ? `${m[1]} ${m[2]}${m[3] && m[3] !== 'Z' ? ` (UTC${m[3]})` : m[3] === 'Z' ? ' UTC' : ''}` : taken); }
  add('Exposure', exposureText(ratio(xmpValue(text, ['exif:ExposureTime']))));
  const fn = ratio(xmpValue(text, ['exif:FNumber']));
  if (fn > 0) add('Aperture', `f/${Math.round(fn * 10) / 10}`);
  add('ISO', xmpValue(text, ['exifEX:PhotographicSensitivity', 'exif:ISOSpeedRatings']));
  const fl = ratio(xmpValue(text, ['exif:FocalLength']));
  if (fl > 0) add('Focal length', `${Math.round(fl * 100) / 100} mm`);
  add('Software', xmpValue(text, ['xmp:CreatorTool', 'tiff:Software']));
  if (rows.length) rows.push(['Source', 'XMP (the file has no EXIF block)']);
  const lat = xmpCoord(xmpValue(text, ['exif:GPSLatitude'])), lon = xmpCoord(xmpValue(text, ['exif:GPSLongitude']));
  let gps = null;
  if (typeof lat === 'number' && typeof lon === 'number') {
    const alt = ratio(xmpValue(text, ['exif:GPSAltitude']));
    gps = { lat: Math.round(lat * 1e7) / 1e7, lon: Math.round(lon * 1e7) / 1e7, alt: isFinite(alt) ? Math.round(alt * 10) / 10 : undefined, latText: fmtDms(lat, 'N', 'S'), lonText: fmtDms(lon, 'E', 'W'), time: '' };
  }
  return { rows, gps };
}

module.exports = { xmpSummary, readExif, summary, allTags, gpsOf, privacyFindings, stripTiff, setOrientation, xmpFindings, stripXmp, ORIENTATION, PRIVATE_EXIF, view };
