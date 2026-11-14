'use strict';
// One opened HEIC, HEIF or AVIF file: the container facts, the list of images and the EXIF of each, in the shape the
// viewer and the Pro tools use. No pixels here (see decoder.js and the webview).
const { parseContainer, itemData, exifTiff } = require('./isobmff');
const X = require('./exif');

const EXTENSIONS = ['heic', 'heif', 'hif', 'avif'];
const EXT_RE = /\.(heic|heif|hif|avif)$/i;

function formatBytes(n) {
  if (!(n >= 0)) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1073741824) return `${(n / 1048576).toFixed(1)} MB`;
  return `${(n / 1073741824).toFixed(2)} GB`;
}

function exifFor(buf, c, im) {
  const id = (im && im.exifIds && im.exifIds[0]) || (c.exif[0] && c.exif[0].id);
  if (!id) return null;
  const item = c.items.find((x) => x.id === id);
  const t = item && exifTiff(buf, item);
  if (!t) return null;
  const parsed = X.readExif(t.tiff);
  return parsed ? { tiff: t.tiff, fileOffset: t.fileOffset, parsed } : null;
}

function xmpText(buf, c) {
  const x = c.xmp[0];
  if (!x) return '';
  const item = c.items.find((i) => i.id === x.id);
  const d = item && itemData(buf, item);
  return d ? Buffer.from(d).toString('utf8') : '';
}

function imageLabel(im, i, n) {
  const parts = [`Image ${i + 1} of ${n}`];
  if (im.primary) parts.push('primary');
  if (im.inputOf) parts.push(`input of ${im.inputOf}`);
  return `${parts[0]}${parts.length > 1 ? ` (${parts.slice(1).join(', ')})` : ''}`;
}

/** Rows for the info panel about one image. */
function imageRows(c, im) {
  const rows = [];
  const add = (k, v) => { if (v !== undefined && v !== null && v !== '') rows.push([k, String(v)]); };
  add('Size', `${im.display.width} x ${im.display.height} px`);
  if (im.cropWidth) add('Stored size', `${im.width} x ${im.height} px, cropped`);
  else if (im.rotation === 90 || im.rotation === 270) add('Stored size', `${im.width} x ${im.height} px`);
  add('Codec', im.type === 'grid' && im.tileCodec ? `${im.tileCodec} in a grid` : im.codec);
  if (im.grid) add('Grid', `${im.grid.columns} x ${im.grid.rows} tiles of ${im.tileWidth} x ${im.tileHeight} px`);
  add('Profile', im.profile);
  add('Bit depth', im.bitDepth ? `${im.bitDepth} bits per channel` : '');
  add('Chroma', im.chroma);
  add('Alpha', im.alpha ? 'Yes (separate alpha image)' : 'No');
  if (im.depth) add('Depth map', 'Yes');
  if (im.otherAux.length) add('Other auxiliary images', im.otherAux.join(', '));
  if (im.rotation) add('Rotation', `${im.rotation}° counter-clockwise (applied)`);
  if (im.mirror) add('Mirror', `${im.mirror} (applied)`);
  const col = im.color;
  const unspecified = !col.icc && (!col.primaries || col.primaries === 'unspecified') && (!col.transfer || col.transfer === 'unspecified');
  if (unspecified) add('Color', 'Not specified in the file (shown as sRGB)');
  else add('Color', [col.icc ? `ICC: ${col.icc}` : '', col.primaries ? `primaries ${col.primaries}` : '', col.transfer ? `transfer ${col.transfer}` : '', col.fullRange === true ? 'full range' : col.fullRange === false ? 'limited range' : ''].filter(Boolean).join(', '));
  if (col.hdr) add('HDR', 'Yes. The viewer shows it tone-mapped to 8 bits, so highlights look flat.');
  if (im.thumbnails.length) add('Thumbnails', im.thumbnails.join(', '));
  return rows;
}

/** Rows for the info panel about the file. */
function fileRows(c, bytes) {
  const rows = [];
  rows.push(['File size', formatBytes(bytes)]);
  rows.push(['Container', `${c.brandName} (brand ${c.brand})`]);
  rows.push(['Compatible brands', c.compatible.join(', ')]);
  rows.push(['Images', String(c.images.length)]);
  rows.push(['Items', String(c.items.length)]);
  if (c.sequence) rows.push(['Image sequence', 'Yes (a video-like track; the viewer shows the still images)']);
  rows.push(['Metadata', [c.exif.length ? 'EXIF' : '', c.xmp.length ? 'XMP' : ''].filter(Boolean).join(', ') || 'None']);
  return rows;
}

/**
 * Opens a HEIC, HEIF or AVIF buffer. Returns { kind, container, images: [{ id, label, width, height, primary, ... }],
 * primaryIndex, fileRows, warnings, exif(im), xmp }. Throws a readable Error for files that are not HEIF.
 */
function openImage(buf, name = '') {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const c = parseContainer(b);
  const images = c.images.map((im, i) => ({
    id: im.id, index: i, label: imageLabel(im, i, c.images.length), primary: im.primary, type: im.type,
    width: im.display.width, height: im.display.height, bitDepth: im.bitDepth, alpha: im.alpha, p3: im.color.p3, hdr: im.color.hdr,
    codec: im.codec, rows: imageRows(c, im), raw: im,
  }));
  let primaryIndex = images.findIndex((x) => x.primary);
  if (primaryIndex < 0) primaryIndex = 0;
  const warnings = c.warnings.slice();
  const isAvif = c.kind === 'avif' || /\.avif$/i.test(name);
  const decodable = (im) => (isAvif ? im.type === 'av01' || im.type === 'grid' || im.type === 'iden' : !['av01', 'vvc1', 'j2k1', 'evc1', 'avc1', 'unci', 'tmap'].includes(im.type) || false);
  if (isAvif && images.length > 1) warnings.push(`This AVIF file holds ${images.length} images. The AVIF decoder shows the primary image only.`);
  if (c.sequence) warnings.push('The file also has an image sequence track. Its frames are not shown; the still images are.');
  return {
    name, kind: isAvif ? 'avif' : c.kind, container: c, images, primaryIndex, warnings,
    fileRows: fileRows(c, b.length),
    decodable: (i) => !!images[i] && decodable(images[i].raw),
    exif: (i) => exifFor(b, c, images[i] ? images[i].raw : null),
    xmp: () => xmpText(b, c),
  };
}

/** Everything the info panel shows for image i: file rows, image rows, camera rows, GPS, all tags, privacy. */
function describe(img, i) {
  const im = img.images[i] || img.images[img.primaryIndex];
  const ex = img.exif(im ? im.index : 0);
  const parsed = ex ? ex.parsed : null;
  const xmp = img.xmp();
  return {
    file: img.fileRows,
    image: im ? im.rows : [],
    camera: parsed ? X.summary(parsed) : X.xmpSummary(xmp).rows,
    gps: parsed ? X.gpsOf(parsed) : X.xmpSummary(xmp).gps,
    tags: X.allTags(parsed),
    privacy: X.privacyFindings(parsed).concat(X.xmpFindings(xmp).map((n) => ({ kind: /GPS|Location|City|State|Country/.test(n) ? 'gps' : 'serial', label: `XMP ${n}`, value: 'present' }))),
    xmpBytes: xmp.length,
  };
}

module.exports = { openImage, describe, formatBytes, EXTENSIONS, EXT_RE };
