'use strict';
// Extension tests with the vscode stub: listing, activation, the custom editor's messages, the three Pro tools (the
// tool panel's webview work is answered by log.onPost like the real panel would), README and support links.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { loadExtension, tmpDir, cleanup } = require('./support/vscode-stub');
const { editorHtml, panelHtml } = require('../src/html');
const { encodePng, decodePng } = require('../src/core/png');
const embed = require('../src/core/embed');
const X = require('../src/core/exif');
const privacy = require('../src/core/privacy');

const ROOT = path.join(__dirname, '..');
const SAMPLES = path.join(ROOT, 'samples');
const FIX = path.join(__dirname, 'fixtures');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));
const until = async (f, ms = 3000) => { const t = Date.now(); while (Date.now() - t < ms) { const v = f(); if (v) return v; await tick(10); } return f(); };
test.after(() => cleanup());

const activated = [];
function activate(folder) {
  const s = loadExtension();
  if (folder) s.vscode.workspace.workspaceFolders = [{ uri: s.vscode.Uri.file(folder), name: 'ws' }];
  s.api = s.ext.activate(s.context);
  activated.push(s);
  // Answer the tool panel like the webview: encode, contact sheet pages, "shown" after the privacy table.
  s.log.onPost = (panel, m) => {
    if (m.type === 'encode') {
      const w = m.src.width || 16, h = m.src.height || 12;
      const bytes = m.mime === 'image/png' ? encodePng(w, h, m.src.rgba || new Uint8Array(w * h * 4).fill(90))
        : m.mime === 'image/jpeg' ? Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xd9])
          : Buffer.concat([Buffer.from('RIFF', 'latin1'), Buffer.from([4 + 8 + 10, 0, 0, 0]), Buffer.from('WEBPVP8L', 'latin1'), Buffer.from([9, 0, 0, 0, 0x2f, 0, 0, 0, 0, 0, 0, 0, 0, 0])]);
      panel.send({ type: 'reply', id: m.id, bytes, width: w, height: h });
    } else if (m.type === 'sheetStart' || m.type === 'tile') panel.send({ type: 'reply', id: m.id });
    else if (m.type === 'render') panel.send({ type: 'reply', id: m.id, pages: m.format === 'image/png' ? [{ bytes: encodePng(4, 4, new Uint8Array(64).fill(255)), width: 1240, height: 1754 }, { bytes: encodePng(4, 4, new Uint8Array(64).fill(255)), width: 1240, height: 1754 }] : [{ bytes: Buffer.from([0xff, 0xd8, 0xff, 0xd9]), width: 1240, height: 1754 }] });
    else if (m.type === 'data') panel.send({ type: 'shown' });
  };
  return s;
}
test.after(() => { for (const s of activated) { try { s.api.decoder().stop(); } catch (e) { /* not started */ } } });

function tmpWs() {
  const dir = tmpDir('heic-ws-');
  fs.mkdirSync(path.join(dir, 'photos', 'sub'), { recursive: true });
  for (const f of fs.readdirSync(SAMPLES)) fs.copyFileSync(path.join(SAMPLES, f), path.join(dir, 'photos', f));
  fs.copyFileSync(path.join(FIX, 'quad-rot6.heic'), path.join(dir, 'photos', 'sub', 'rot.heic'));
  fs.copyFileSync(path.join(FIX, 'quad-rot6.jpg'), path.join(dir, 'photos', 'sub', 'phone.jpg'));
  fs.copyFileSync(path.join(FIX, 'quad.heic'), path.join(dir, 'photos', 'sub', 'quad.heic'));
  fs.writeFileSync(path.join(dir, 'photos', 'sub', 'broken.heic'), 'not a heic file');
  return dir;
}
function fakePanel() {
  let onMsg;
  const posted = [];
  return {
    posted, viewColumn: 1, active: true,
    webview: { options: {}, html: '', cspSource: 'vscode-resource:', asWebviewUri: (u) => u, postMessage: async (m) => { posted.push(m); return true; }, onDidReceiveMessage: (f) => { onMsg = f; return { dispose() {} }; } },
    onDidChangeViewState: () => ({ dispose() {} }), onDidDispose: () => ({ dispose() {} }), reveal() {},
    send: (m) => onMsg(m),
  };
}
async function openEditor(s, file) {
  const prov = s.providers.custom.p;
  const handle = await prov.openCustomDocument(s.vscode.Uri.file(file));
  const panel = fakePanel();
  await prov.resolveCustomEditor(handle, panel);
  await panel.send({ type: 'ready' });
  return { prov, handle, panel, doc: handle._doc };
}

// ---------- package.json and listing ----------
test('listing: display name with the phrase first, 30 characters or less, 5 keywords, engines low enough for Cursor and Windsurf', () => {
  assert.equal(pkg.displayName, 'HEIC Viewer & AVIF Viewer');
  assert.ok(pkg.displayName.length <= 30);
  assert.ok(pkg.description.startsWith('HEIC viewer'));
  assert.deepEqual(pkg.keywords, ['heic', 'heif', 'avif', 'image viewer', 'iphone photos']);
  assert.equal(pkg.engines.vscode, '^1.75.0');
  assert.equal(`${pkg.publisher}.${pkg.name}`, 'zovo.zovo-heic-viewer');
  assert.deepEqual(pkg.contributes.customEditors[0].selector.map((s) => s.filenamePattern), ['*.heic', '*.heif', '*.hif']);
  assert.equal(pkg.contributes.customEditors[0].priority, 'default');
  // .avif: VS Code's own image preview is the default; ours is an option, so VS Code never asks which editor to use.
  assert.deepEqual([pkg.contributes.customEditors[1].viewType, pkg.contributes.customEditors[1].selector[0].filenamePattern, pkg.contributes.customEditors[1].priority], ['heicViewer.avif', '*.avif', 'option']);
});
test('every contributed command is registered, and every registered heicViewer command is contributed', () => {
  const s = activate();
  const contributed = pkg.contributes.commands.map((c) => c.command);
  for (const c of contributed) assert.ok(s.commands.has(c), `not registered: ${c}`);
  for (const c of s.commands.keys()) if (c.startsWith('heicViewer.')) assert.ok(contributed.includes(c), `not in package.json: ${c}`);
  const menus = Object.values(pkg.contributes.menus).flat().map((m) => m.command);
  for (const c of menus) assert.ok(contributed.includes(c), `menu names an unknown command: ${c}`);
});
test('Open in HEIC Viewer picks the AVIF view type for .avif files', async () => {
  const s = activate();
  await s.vscode.commands.executeCommand('heicViewer.openWithViewer', s.vscode.Uri.file('/x/a.avif'));
  await s.vscode.commands.executeCommand('heicViewer.openWithViewer', s.vscode.Uri.file('/x/a.HEIC'));
  const calls = s.log.commands.filter((c) => c[0] === 'vscode.openWith').map((c) => c[2]);
  assert.deepEqual(calls, ['heicViewer.avif', 'heicViewer.editor']);
});
test('activation shows nothing: no message, no panel, no editor, no decoder started', () => {
  const s = activate();
  assert.equal(s.log.info.length + s.log.warn.length + s.log.error.length, 0);
  assert.equal(s.log.panel, undefined);
  assert.equal(s.log.opened.length, 0);
  assert.equal(s.log.external.length, 0);
});
test('the package ships libheif as a separate WASM file with its LGPL licence text', () => {
  for (const f of ['libheif.js', 'libheif.wasm', 'LICENSE-libheif.txt', 'LICENSE-libheif-js.txt']) assert.ok(fs.existsSync(path.join(ROOT, 'lib', 'libheif', f)), f);
  assert.match(fs.readFileSync(path.join(ROOT, 'lib', 'libheif', 'LICENSE-libheif.txt'), 'utf8'), /GNU LESSER GENERAL PUBLIC LICENSE/);
  assert.match(fs.readFileSync(path.join(ROOT, 'THIRD-PARTY-NOTICES.md'), 'utf8'), /LGPL-3\.0/);
  const ignore = fs.readFileSync(path.join(ROOT, '.vscodeignore'), 'utf8');
  assert.doesNotMatch(ignore, /^lib\//m);
});

// ---------- the viewer ----------
test('viewer: the HEIC sample sends meta, info (camera, GPS numbers, privacy) and the decoded 1600 x 1066 image', async () => {
  const s = activate();
  const { panel } = await openEditor(s, path.join(SAMPLES, 'sample-wind-farm.heic'));
  const img = await until(() => panel.posted.find((m) => m.type === 'image'), 10000);
  const meta = panel.posted.find((m) => m.type === 'meta');
  const info = panel.posted.find((m) => m.type === 'info');
  assert.equal(meta.kind, 'heic');
  assert.equal(meta.images.length, 1);
  assert.equal(meta.privacyTool, 'heicViewer.privacy');
  assert.deepEqual([info.gps.lat, info.gps.lon], [52.3751389, 9.7367361]);
  assert.ok(info.camera.some(([k, v]) => k === 'Camera' && v === 'NIKON Z 8'));
  assert.deepEqual([img.width, img.height, img.rgba.length], [1600, 1066, 1600 * 1066 * 4]);
  assert.match(panel.webview.html, /Content-Security-Policy/);
  assert.ok(panel.webview.options.enableCommandUris.includes('heicViewer.convert'));
});
test('viewer: an AVIF goes to the webview as bytes for the editor\'s own decoder', async () => {
  const s = activate();
  const { panel } = await openEditor(s, path.join(SAMPLES, 'sample-wind-farm.avif'));
  const av = await until(() => panel.posted.find((m) => m.type === 'avif'));
  assert.equal(av.mime, 'image/avif');
  assert.equal(av.bytes.length, fs.statSync(path.join(SAMPLES, 'sample-wind-farm.avif')).size);
  assert.equal(panel.posted.filter((m) => m.type === 'image').length, 0);
});
test('viewer: a .heic that is really a JPEG is shown with a note, not an error', async () => {
  const dir = tmpDir('heic-mis-');
  const f = path.join(dir, 'IMG_0001.heic');
  fs.copyFileSync(path.join(FIX, 'quad-rot6.jpg'), f);
  const s = activate();
  const { panel } = await openEditor(s, f);
  const meta = panel.posted.find((m) => m.type === 'meta');
  assert.match(meta.warnings[0], /really a JPEG/);
  assert.equal(panel.posted.find((m) => m.type === 'avif').mime, 'image/jpeg');
});
test('viewer: a broken file shows the reason, never throws; maxFileSizeMB refuses big files', async () => {
  const dir = tmpWs();
  const s = activate();
  const { panel } = await openEditor(s, path.join(dir, 'photos', 'sub', 'broken.heic'));
  assert.match(panel.posted.find((m) => m.type === 'meta').error, /HEIC/);
  s.config.maxFileSizeMB = 1;
  const big = path.join(dir, 'photos', 'big.heic');
  fs.writeFileSync(big, Buffer.concat([fs.readFileSync(path.join(SAMPLES, 'sample-wind-farm.heic')), Buffer.alloc(1200 * 1024)]));
  const r = await openEditor(s, big);
  assert.match(r.panel.posted.find((m) => m.type === 'meta').error, /maxFileSizeMB/);
});
test('viewer: shown message counts a success once; copy goes to the clipboard; select decodes the chosen image', async () => {
  const s = activate();
  const { panel, doc } = await openEditor(s, path.join(FIX, 'quad-rot6.heic'));
  const img = await until(() => panel.posted.find((m) => m.type === 'image'));
  assert.deepEqual([img.width, img.height], [48, 64]);
  await panel.send({ type: 'copy', text: '-33.865, -70.5' });
  assert.equal(s.log.clipboard, '-33.865, -70.5');
  panel.posted.length = 0;
  await panel.send({ type: 'select', index: 0 });
  assert.equal(doc.current, 0);
  assert.ok(panel.posted.some((m) => m.type === 'info'));
  await panel.send({ type: 'command', id: 'workbench.action.quit' });
  assert.ok(!s.log.commands.some((c) => c[0] === 'workbench.action.quit'));
});

// ---------- HTML ----------
test('webview HTML: strict CSP, nonce scripts, no remote URLs, blob images allowed for AVIF', () => {
  for (const html of [editorHtml({ cspSource: 'vscode-resource:', scriptUri: 'a.js', styleUri: 'a.css', title: '<x>' }), panelHtml({ cspSource: 'vscode-resource:', scriptUri: 'p.js', styleUri: 'p.css', title: 't' })]) {
    const csp = /content="([^"]+)"/.exec(html)[1];
    assert.match(csp, /default-src 'none'/);
    assert.match(csp, /img-src [^;]*blob:/);
    assert.doesNotMatch(csp, /connect-src|unsafe-eval|https?:/);
    const nonce = /'nonce-([^']+)'/.exec(csp)[1];
    for (const m of html.matchAll(/<script([^>]*)>/g)) assert.match(m[1], new RegExp(`nonce="${nonce}"`));
    assert.doesNotMatch(html, /<x>/);
  }
});
test('media scripts load nothing remote and set no inline style attributes in HTML strings', () => {
  for (const f of ['viewer.js', 'panel.js']) {
    const src = fs.readFileSync(path.join(ROOT, 'media', f), 'utf8');
    assert.doesNotMatch(src, /fetch\(|XMLHttpRequest|WebSocket|https?:\/\//);
    assert.doesNotMatch(src, /style="/);
  }
  assert.match(fs.readFileSync(path.join(ROOT, 'media', 'viewer.css'), 'utf8'), /\[hidden\] \{ display: none !important; \}/);
});
test('no source file opens a network connection', () => {
  const files = ['extension.js', 'editor.js', 'tools.js', 'html.js', 'core/isobmff.js', 'core/exif.js', 'core/heif.js', 'core/decoder.js', 'core/heic-worker.js', 'core/embed.js', 'core/privacy.js', 'core/pdf.js'];
  for (const f of files) assert.doesNotMatch(fs.readFileSync(path.join(ROOT, 'src', f), 'utf8'), /require\(['"](https?|net|tls|dgram|undici)['"]\)|fetch\(/, f);
});

// ---------- Pro tools ----------
test('Pro convert: one HEIC to PNG keeps EXIF without GPS and serial; a try counts after the file is written', async () => {
  const dir = tmpWs();
  const s = activate(dir);
  const uri = s.vscode.Uri.file(path.join(dir, 'photos', 'sample-wind-farm.heic'));
  s.ui.quick.push((items) => items.find((i) => i.id === 'png'), (items) => items.find((i) => i.id === 1024), (items) => items.find((i) => i.id === 'nogps'));
  const r = await s.api.tools.convertTool(uri);
  assert.equal(r.rows.length, 1);
  assert.equal(r.rows[0].ok, true, r.rows[0].reason);
  const out = fs.readFileSync(r.files[0].fsPath);
  assert.equal(path.basename(r.files[0].fsPath), 'sample-wind-farm.png');
  assert.deepEqual([decodePng(out).width, decodePng(out).height], [1024, 682]);
  const ex = X.readExif(embed.readBackExif(out));
  assert.equal(X.gpsOf(ex), null);
  assert.equal(X.privacyFindings(ex).length, 0);
  assert.equal(Object.fromEntries(X.summary(ex)).Camera, 'NIKON Z 8');
  assert.equal(s.api.pro.left('convert'), 2);
});
test('Pro convert: a folder to JPEG mirrors subfolders, writes a report, lists broken files as skipped', async () => {
  const dir = tmpWs();
  const s = activate(dir);
  s.ui.quick.push((items) => items.find((i) => i.id === 'jpeg'), (items) => items.find((i) => i.id === 0), (items) => items.find((i) => i.id === 'keep'));
  const r = await s.api.tools.convertTool(s.vscode.Uri.file(path.join(dir, 'photos')));
  assert.equal(r.rows.length, 5);
  assert.equal(r.rows.filter((x) => x.ok).length, 4);
  assert.ok(fs.existsSync(path.join(dir, 'photos-jpeg', 'sub', 'rot.jpg')));
  assert.ok(fs.existsSync(path.join(dir, 'photos-jpeg', 'sample-wind-farm.jpg')));
  const report = fs.readFileSync(r.report.fsPath, 'utf8');
  assert.match(report, /^# Converted 4 of 5 images to JPEG/);
  assert.match(report, /sub\/broken\.heic \| skipped/);
  const kept = X.readExif(embed.readBackExif(fs.readFileSync(path.join(dir, 'photos-jpeg', 'sub', 'rot.jpg'))));
  assert.equal(X.gpsOf(kept).lat, -33.865);
  assert.match(Object.fromEntries(X.summary(kept))['EXIF orientation'], /^1 /);
});
test('Pro convert: Escape in a pick uses no try; the 4th use opens the Zovo Pro panel and writes nothing', async () => {
  const dir = tmpWs();
  const s = activate(dir);
  const uri = s.vscode.Uri.file(path.join(dir, 'photos', 'sub', 'quad.heic'));
  s.ui.quick.push(undefined);
  await s.api.tools.convertTool(uri);
  assert.equal(s.api.pro.left('convert'), 3);
  for (let i = 0; i < 3; i++) { s.ui.quick.push((it) => it.find((x) => x.id === 'webp'), (it) => it[0], (it) => it.find((x) => x.id === 'none')); const r = await s.api.tools.convertTool(uri); assert.equal(r.rows[0].ok, true, r.rows[0].reason); }
  assert.equal(s.api.pro.left('convert'), 0);
  const before = fs.readdirSync(path.join(dir, 'photos', 'sub')).length;
  s.ui.quick.push((it) => it.find((x) => x.id === 'webp'), (it) => it[0], (it) => it[0]);
  const r = await s.api.tools.convertTool(uri);
  assert.equal(r, undefined);
  assert.equal(fs.readdirSync(path.join(dir, 'photos', 'sub')).length, before);
  assert.equal(s.api.pro.left('sheet'), 3);
});
test('Pro contact sheet: PDF of a folder; a try counts after the PDF is saved', async () => {
  const dir = tmpWs();
  const s = activate(dir);
  s.ui.quick.push((items) => items.find((i) => i.id === 'pdf'));
  const r = await s.api.tools.sheetTool(s.vscode.Uri.file(path.join(dir, 'photos')));
  assert.equal(r.tiles, 6);
  assert.equal(path.basename(r.files[0].fsPath), 'contact-sheet.pdf');
  assert.match(fs.readFileSync(r.files[0].fsPath, 'latin1'), /^%PDF-1\.4[\s\S]*\/Count 1/);
  const tiles = s.log.panel.posted.filter((m) => m.type === 'tile');
  assert.equal(tiles.length, 6);
  assert.ok(tiles.some((t) => t.src && t.src.mime === 'image/avif'));
  assert.ok(tiles.some((t) => t.src === null && /cannot be read/.test(t.sub)));
  assert.ok(tiles.filter((t) => t.src && t.src.rgba).every((t) => Math.max(t.src.width, t.src.height) <= 480));
  assert.equal(s.api.pro.left('sheet'), 2);
});
test('Pro contact sheet: PNG pages are numbered files', async () => {
  const dir = tmpWs();
  const s = activate(dir);
  s.ui.quick.push((items) => items.find((i) => i.id === 'png'));
  const r = await s.api.tools.sheetTool(s.vscode.Uri.file(path.join(dir, 'photos')));
  assert.deepEqual(r.files.map((f) => path.basename(f.fsPath)), ['contact-sheet-1.png', 'contact-sheet-2.png']);
});
test('Pro privacy: lists GPS, serials and owner names; the try counts when the table is shown; strip in place cleans them', async () => {
  const dir = tmpWs();
  const s = activate(dir);
  const data = await s.api.tools.privacyTool(s.vscode.Uri.file(path.join(dir, 'photos')));
  assert.equal(data.totals.files, 6);
  assert.equal(data.totals.gps, 5);
  assert.equal(data.totals.unreadable, 1);
  const rot = data.rows.find((r) => r.path === 'sub/rot.heic');
  assert.equal(rot.gps, '-33.865, -70.5');
  assert.match(rot.owner, /Test Owner/);
  await until(() => s.api.pro.left('privacy') === 2);
  assert.equal(s.api.pro.left('privacy'), 2);
  const panel = s.log.panel;
  const heicBefore = fs.readFileSync(path.join(dir, 'photos', 'sub', 'rot.heic'));
  s.ui.warn.push('Remove');
  await panel.send({ type: 'action', id: 'strip' });
  const after = fs.readFileSync(path.join(dir, 'photos', 'sub', 'rot.heic'));
  assert.equal(after.length, heicBefore.length);
  assert.equal(privacy.scan(after, 'rot.heic').findings.length, 0);
  assert.equal(privacy.scan(fs.readFileSync(path.join(dir, 'photos', 'sub', 'phone.jpg')), 'phone.jpg').findings.length, 0);
  const last = panel.posted.filter((m) => m.type === 'data').pop().data;
  assert.equal(last.totals.flagged, 0);
  assert.match(last.note, /Removed from 5 photos in place/);
  assert.equal(s.api.pro.left('privacy'), 2);
});
test('Pro privacy: cleaned copies leave the originals alone; CSV export; Cancel on the confirm changes nothing', async () => {
  const dir = tmpWs();
  const s = activate(dir);
  await s.api.tools.privacyTool(s.vscode.Uri.file(path.join(dir, 'photos')));
  const panel = s.log.panel;
  s.ui.warn.push(undefined);
  await panel.send({ type: 'action', id: 'strip' });
  assert.equal(privacy.scan(fs.readFileSync(path.join(dir, 'photos', 'sub', 'rot.heic')), 'rot.heic').findings.length, 3);
  await panel.send({ type: 'action', id: 'copies' });
  assert.equal(privacy.scan(fs.readFileSync(path.join(dir, 'photos', 'sub', 'rot-clean.heic')), 'x.heic').findings.length, 0);
  assert.equal(privacy.scan(fs.readFileSync(path.join(dir, 'photos', 'sub', 'rot.heic')), 'rot.heic').findings.length, 3);
  const dest = path.join(dir, 'privacy.csv');
  s.ui.save.push(s.vscode.Uri.file(dest));
  await panel.send({ type: 'action', id: 'csv' });
  assert.match(fs.readFileSync(dest, 'utf8'), /^path,gps,serial_numbers,owner_or_id,camera,taken,error\n/);
});
test('Pro tools from the viewer: the privacy button and the toolbar row pass the toolbar surface', async () => {
  const s = activate();
  const { panel } = await openEditor(s, path.join(SAMPLES, 'sample-wind-farm.heic'));
  s.ui.quick.push(undefined);
  await panel.send({ type: 'command', id: 'heicViewer.convert' });
  await tick(20);
  assert.ok(s.log.lastPick.items.some((i) => i.id === 'jpeg'));
  // The pick stays open when focus goes back to the webview after the Command Palette closes.
  assert.equal(s.log.lastPick.opts.ignoreFocusOut, true);
});

// ---------- README and text ----------
test('README: first screen has the main use, a screenshot of this product, the free list and the price; by Zovo; no rival names', () => {
  const md = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  const first = md.split('\n').slice(0, 30).join('\n');
  assert.match(first, /^# HEIC Viewer & AVIF Viewer/);
  assert.match(first, /images\/screenshot\.png/);
  assert.match(first, /Zovo Pro: USD 19 once/);
  assert.match(md, /by Zovo/);
  assert.doesNotMatch(md, /nuriyev|Vingertop|ovcharovcoder|heic-preview|libheif-js preview/i);
  assert.ok(fs.existsSync(path.join(ROOT, 'images', 'screenshot.png')));
});
test('support links name this listing and related Zovo tools', () => {
  const support = require('../src/support');
  assert.equal(support.SELF_ID, 'zovo.zovo-heic-viewer');
  assert.ok(support.RELATED.length >= 3 && !support.RELATED.includes(support.SELF_ID));
  assert.equal(support.PRO.getPro, 'heicViewer.getPro');
});
