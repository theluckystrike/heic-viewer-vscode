'use strict';
// The three Zovo Pro tools: Convert to JPEG, PNG or WebP; Contact sheet; Privacy check. Each asks pro.allowed()
// before it starts and calls pro.produced() only after its result is on disk or on screen, so Escape, Cancel or an
// error never uses a free try. Everything runs on this computer: HEIC decoding in the decoder worker, AVIF decoding
// and JPEG, PNG and WebP encoding in the tool's own webview panel (the editor's image codecs), metadata in Node.
const vscode = require('vscode');
const path = require('path');
const { openImage, formatBytes, EXT_RE } = require('./core/heif');
const { exifTiff } = require('./core/isobmff');
const embed = require('./core/embed');
const privacy = require('./core/privacy');
const X = require('./core/exif');
const { makePdf } = require('./core/pdf');
const { sniffOther } = require('./editor');
const { panelHtml } = require('./html');
const support = require('./support');

const PREFIX = 'heicViewer';
const SHEET_RE = /\.(heic|heif|hif|avif|jpe?g|png|webp)$/i;
const SKIP_DIRS = new Set(['node_modules', '.git', '.svn', '.hg', '.cache', 'dist', 'out', '__pycache__']);
const MAX_FILES = 5000;
const FORMATS = {
  jpeg: { mime: 'image/jpeg', ext: 'jpg', label: 'JPEG' },
  png: { mime: 'image/png', ext: 'png', label: 'PNG' },
  webp: { mime: 'image/webp', ext: 'webp', label: 'WebP' },
};
const setting = (k, d) => vscode.workspace.getConfiguration(PREFIX).get(k, d);
const base = (uri) => path.posix.basename(uri.path);
const stem = (name) => name.replace(/\.[^.]+$/, '');
const mdCell = (s) => String(s).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
const csvCell = (s) => (/[",\n]/.test(String(s)) ? `"${String(s).replace(/"/g, '""')}"` : String(s));

function createTools({ context, provider, pro, reach, decoder }) {
  const panels = {};
  const getDecoder = typeof decoder === 'function' ? decoder : () => decoder;

  // ---------- files ----------
  async function isDir(uri) { try { return (await vscode.workspace.fs.stat(uri)).type === vscode.FileType.Directory; } catch (e) { return false; } }
  async function exists(uri) { try { await vscode.workspace.fs.stat(uri); return true; } catch (e) { return false; } }
  async function walk(root, re, token) {
    const out = [];
    const queue = [root];
    while (queue.length && out.length < MAX_FILES) {
      if (token && token.isCancellationRequested) break;
      const dir = queue.shift();
      let entries;
      try { entries = await vscode.workspace.fs.readDirectory(dir); } catch (e) { continue; }
      entries.sort((a, b) => a[0].localeCompare(b[0]));
      for (const [name, type] of entries) {
        const u = vscode.Uri.joinPath(dir, name);
        if (type & vscode.FileType.Directory) { if (!SKIP_DIRS.has(name) && !name.startsWith('.')) queue.push(u); } else if (re.test(name)) out.push(u);
        if (out.length >= MAX_FILES) break;
      }
    }
    return out;
  }
  const rel = (root, u) => path.posix.relative(root.path, u.path) || base(u);
  async function uniqueFile(dir, name) {
    let u = vscode.Uri.joinPath(dir, name);
    for (let i = 2; await exists(u) && i < 1000; i++) u = vscode.Uri.joinPath(dir, `${stem(name)}-${i}${path.posix.extname(name)}`);
    return u;
  }
  async function uniqueFolder(parent, name) {
    let u = vscode.Uri.joinPath(parent, name);
    for (let i = 2; await exists(u) && i < 1000; i++) u = vscode.Uri.joinPath(parent, `${name}-${i}`);
    return u;
  }
  async function readBytes(uri) { const d = await vscode.workspace.fs.readFile(uri); return new Uint8Array(d.buffer, d.byteOffset, d.byteLength); }
  async function pickFolder(title) {
    const r = await vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true, canSelectMany: false, openLabel: 'Choose folder', title, defaultUri: (vscode.workspace.workspaceFolders || [])[0]?.uri });
    return r && r[0];
  }
  async function pickFiles(title) {
    const r = await vscode.window.showOpenDialog({ canSelectMany: true, openLabel: 'Choose', title, filters: { 'HEIC and AVIF images': ['heic', 'heif', 'hif', 'avif'], 'All files': ['*'] } });
    return r && r.length ? r : undefined;
  }
  /** The file the tool should use: the clicked one, else the image in the active viewer. */
  function activeUri(arg) {
    if (arg && arg.scheme) return arg;
    const d = provider.active;
    return d ? d.uri : undefined;
  }

  /**
   * A decodable source for the webview: { src: { rgba, width, height } | { bytes, mime }, img, im, name, tiff }.
   * index: image index (undefined = primary); maxSide: longest side for HEIC (the worker shrinks it).
   */
  async function sourceOf(uri, { index, maxSide } = {}) {
    const bytes = await readBytes(uri);
    const name = base(uri);
    const other = sniffOther(bytes) || (/\.webp$/i.test(name) ? 'image/webp' : '');
    if (other) return { src: { bytes: bytes.slice(), mime: other }, img: null, im: null, name, tiff: jpegTiff(bytes) };
    const img = openImage(bytes, name);
    const i = typeof index === 'number' ? index : img.primaryIndex;
    const im = img.images[i];
    if (!im) throw new Error(img.container.sequence ? 'only an image sequence, no still image' : 'no image in the file');
    if (!img.decodable(i)) throw new Error(`${im.codec} cannot be decoded by this viewer`);
    const ex = img.exif(i);
    const tiff = ex ? ex.tiff : null;
    if (img.kind === 'avif') return { src: { bytes: bytes.slice(), mime: 'image/avif' }, img, im, name, tiff };
    const r = await getDecoder().decodeHeic({ bytes, itemId: im.id, maxSide: maxSide || 0 });
    if (r.error) throw new Error(r.error);
    return { src: { rgba: r.rgba, width: r.width, height: r.height }, img, im, name, tiff };
  }
  function jpegTiff(bytes) {
    try { const b = privacy.jpegBlocks(bytes).find((k) => k.kind === 'exif'); return b ? bytes.subarray(b.start, b.end) : null; } catch (e) { return null; }
  }

  // ---------- panels ----------
  /** Opens (or reuses) the panel of a tool. Returns { panel, ready, request(msg), post(msg), onAction }. */
  function openPanel(kind, title) {
    const media = vscode.Uri.joinPath(context.extensionUri, 'media');
    let p = panels[kind];
    if (p && !p.disposed) { p.panel.title = title; p.panel.reveal(vscode.ViewColumn.Beside, false); return p; }
    const panel = vscode.window.createWebviewPanel(`${PREFIX}.${kind}`, title, { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false }, {
      enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [media],
      enableCommandUris: (reach ? reach.commandIds() : []).concat(support.commandUris(PREFIX)),
    });
    panel.webview.html = panelHtml({
      cspSource: panel.webview.cspSource,
      scriptUri: panel.webview.asWebviewUri(vscode.Uri.joinPath(media, 'panel.js')).toString(),
      styleUri: panel.webview.asWebviewUri(vscode.Uri.joinPath(media, 'panel.css')).toString(),
      title, head: reach ? (n) => reach.headHtml(n) : undefined, showSupportLinks: setting('showSupportLinks', true) !== false,
    });
    if (reach) reach.attach(panel.webview, panel);
    let readyFn;
    const pending = new Map();
    let seq = 0;
    p = { panel, kind, disposed: false, actions: null, shown: null };
    p.ready = new Promise((r) => { readyFn = r; });
    p.post = (msg) => { try { const r = panel.webview.postMessage(msg); if (r && r.then) r.then(undefined, () => false); } catch (e) { /* disposed */ } };
    p.request = (msg) => new Promise((resolve, reject) => {
      if (p.disposed) { reject(new Error('The panel was closed.')); return; }
      const id = ++seq;
      pending.set(id, { resolve, reject });
      p.post({ ...msg, id });
    });
    panel.webview.onDidReceiveMessage(async (m) => {
      if (reach && reach.onMessage(m)) return;
      if (!m || typeof m !== 'object') return;
      if (m.type === 'ready') readyFn();
      else if (m.type === 'reply' && pending.has(m.id)) { const q = pending.get(m.id); pending.delete(m.id); if (m.error) q.reject(new Error(m.error)); else q.resolve(m); }
      else if (m.type === 'shown') { if (p.shown) { const f = p.shown; p.shown = null; await f(); } }
      else if (m.type === 'action' && p.actions) await p.actions(m.id, m);
    });
    panel.onDidDispose(() => { p.disposed = true; for (const q of pending.values()) q.reject(new Error('The panel was closed.')); pending.clear(); if (panels[kind] === p) delete panels[kind]; });
    panels[kind] = p;
    return p;
  }

  // ---------- 1. Convert ----------
  async function convertTool(arg, many) {
    let targets = Array.isArray(many) && many.length > 1 ? many.filter((u) => u && u.scheme) : null;
    let folder = null;
    const one = activeUri(arg);
    if (!targets) {
      if (one && await isDir(one)) folder = one;
      else if (one) targets = [one];
      else {
        const how = await vscode.window.showQuickPick([
          { label: 'Choose files...', id: 'files' },
          { label: 'Choose a folder...', id: 'folder', description: 'every HEIC, HEIF and AVIF image in it and its subfolders' },
        ], { ignoreFocusOut: true, title: 'Convert HEIC and AVIF images', placeHolder: 'What to convert' });
        if (!how) return undefined;
        if (how.id === 'folder') { folder = await pickFolder('Folder of HEIC and AVIF images to convert'); if (!folder) return undefined; } else { targets = await pickFiles('HEIC and AVIF images to convert'); if (!targets) return undefined; }
      }
    }
    if (!(await pro.allowed('convert', arg))) return undefined;
    const q = Math.min(100, Math.max(10, Number(setting('quality', 90)) || 90));
    const fmt = await vscode.window.showQuickPick([
      { label: 'JPEG', id: 'jpeg', description: `quality ${q}`, detail: 'Opens everywhere. Smallest choice for photos that every app can read.' },
      { label: 'PNG', id: 'png', description: 'lossless', detail: 'Exact pixels and transparency, larger files.' },
      { label: 'WebP', id: 'webp', description: `quality ${q}`, detail: 'Smaller than JPEG at the same look; for the web.' },
    ], { ignoreFocusOut: true, title: 'Convert to', placeHolder: 'Output format (the quality is the "heicViewer.quality" setting)' });
    if (!fmt) return undefined;
    const size = await vscode.window.showQuickPick([
      { label: 'Original size', id: 0 },
      { label: 'Longest side 4096 px', id: 4096 },
      { label: 'Longest side 2048 px', id: 2048 },
      { label: 'Longest side 1024 px', id: 1024 },
    ], { ignoreFocusOut: true, title: 'Size', placeHolder: 'Smaller images are never enlarged' });
    if (!size) return undefined;
    const meta = await vscode.window.showQuickPick([
      { label: 'Keep EXIF, remove GPS and serial numbers', id: 'nogps', detail: 'Camera, lens, date and exposure stay. Position, serial numbers and owner names go.' },
      { label: 'Keep all EXIF', id: 'keep', detail: 'Everything the photo had, GPS included.' },
      { label: 'Remove all metadata', id: 'none' },
    ], { ignoreFocusOut: true, title: 'Metadata', placeHolder: 'What happens to the EXIF of each photo' });
    if (!meta) return undefined;
    let every = false;
    if (targets && targets.length === 1 && !folder) {
      try {
        const img = openImage(await readBytes(targets[0]), base(targets[0]));
        if (img.kind !== 'avif' && img.images.length > 1) {
          const e = await vscode.window.showQuickPick([{ label: 'Primary image only', id: false }, { label: `Every image (${img.images.length})`, id: true }], { ignoreFocusOut: true, title: 'This file holds several images' });
          if (!e) return undefined;
          every = e.id;
        }
      } catch (e) { /* unreadable: the loop below reports it */ }
    }
    const files = folder ? await walk(folder, EXT_RE) : targets;
    if (!files.length) { vscode.window.showInformationMessage(`No .heic, .heif or .avif files in ${folder ? base(folder) : 'the selection'}.`); return undefined; }
    const F = FORMATS[fmt.id];
    const outRoot = folder ? await uniqueFolder(vscode.Uri.joinPath(folder, '..'), `${base(folder)}-${fmt.id}`) : null;
    const p = openPanel('convert', `Convert to ${F.label}`);
    await p.ready;
    p.post({ type: 'mode', kind: 'convert', title: `Converting ${files.length} file${files.length === 1 ? '' : 's'} to ${F.label}`, total: files.length });
    const rows = [], written = [];
    const metaLabel = { nogps: 'EXIF without GPS and serials', keep: 'all EXIF', none: 'no metadata' }[meta.id];
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Converting to ${F.label}`, cancellable: true }, async (progress, token) => {
      for (let k = 0; k < files.length; k++) {
        if (token.isCancellationRequested) break;
        const f = files[k];
        const name = folder ? rel(folder, f) : base(f);
        progress.report({ message: `${k + 1} of ${files.length}: ${name}`, increment: 100 / files.length });
        let indices = [undefined];
        if (every) { try { indices = openImage(await readBytes(f), base(f)).images.map((im) => im.index); } catch (e) { indices = [undefined]; } }
        for (const index of indices) {
          const label = index === undefined ? name : `${name} (image ${index + 1})`;
          try {
            const s = await sourceOf(f, { index, maxSide: size.id });
            const r = await p.request({ type: 'encode', src: s.src, mime: F.mime, quality: q / 100, maxSide: size.id });
            const tiff = embed.exifForOutput(s.tiff, meta.id);
            const out = embed.withExif(fmt.id, r.bytes, tiff, r.width, r.height);
            const outName = `${stem(base(f))}${index === undefined ? '' : `_${index + 1}`}.${F.ext}`;
            let dest;
            if (outRoot) { const sub = path.posix.dirname(rel(folder, f)); dest = vscode.Uri.joinPath(outRoot, ...(sub === '.' ? [] : sub.split('/')), outName); } else dest = await uniqueFile(vscode.Uri.joinPath(f, '..'), outName);
            await vscode.workspace.fs.writeFile(dest, out);
            written.push(dest);
            const row = { path: label, ok: true, out: outRoot ? rel(outRoot, dest) : base(dest), width: r.width, height: r.height, bytes: out.length, size: formatBytes(out.length), metadata: tiff ? metaLabel : 'no metadata' };
            rows.push(row);
            p.post({ type: 'row', row });
          } catch (e) {
            const row = { path: label, ok: false, reason: String((e && e.message) || e) };
            rows.push(row);
            p.post({ type: 'row', row });
            if (/panel was closed/.test(row.reason)) break;
          }
        }
        if (p.disposed) break;
      }
    });
    const ok = rows.filter((r) => r.ok).length;
    let report = null;
    if (outRoot && rows.length) {
      const lines = [`# Converted ${ok} of ${rows.length} images to ${F.label}`, '', `Source: ${folder.fsPath}`, `Output: ${outRoot.fsPath}`, `Quality: ${fmt.id === 'png' ? 'lossless' : q}. Size: ${size.label}. Metadata: ${metaLabel}.`, '', '| Source | Result | Output | Size |', '|---|---|---|---|'];
      for (const r of rows) lines.push(r.ok ? `| ${mdCell(r.path)} | converted | ${mdCell(r.out)} | ${r.width} x ${r.height}, ${r.size} |` : `| ${mdCell(r.path)} | skipped | ${mdCell(r.reason)} | |`);
      report = vscode.Uri.joinPath(outRoot, 'CONVERT-REPORT.md');
      await vscode.workspace.fs.writeFile(report, Buffer.from(lines.join('\n') + '\n', 'utf8'));
    }
    p.post({ type: 'done', text: `Converted ${ok} of ${rows.length}${outRoot ? ` into ${outRoot.fsPath}` : ''}.` });
    if (ok > 0) await pro.produced('convert');
    return { rows, files: written, report, outRoot };
  }

  // ---------- 2. Contact sheet ----------
  async function sheetTool(arg) {
    let folder = activeUri(arg);
    if (folder && !(await isDir(folder))) folder = vscode.Uri.joinPath(folder, '..');
    if (!folder) folder = await pickFolder('Folder of photos for the contact sheet');
    if (!folder) return undefined;
    if (!(await pro.allowed('sheet', arg))) return undefined;
    const files = await walk(folder, SHEET_RE);
    if (!files.length) { vscode.window.showInformationMessage(`No HEIC, AVIF, JPEG or PNG photos in ${base(folder)}.`); return undefined; }
    const out = await vscode.window.showQuickPick([
      { label: 'PDF', id: 'pdf', description: 'A4 pages', detail: 'One file to print or send.' },
      { label: 'PNG', id: 'png', description: 'one image per A4 page' },
    ], { ignoreFocusOut: true, title: `Contact sheet of ${files.length} photo${files.length === 1 ? '' : 's'}`, placeHolder: 'Save as' });
    if (!out) return undefined;
    const columns = Math.min(8, Math.max(2, Number(setting('sheetColumns', 4)) || 4));
    const p = openPanel('sheet', `Contact sheet: ${base(folder)}`);
    await p.ready;
    p.post({ type: 'mode', kind: 'sheet', title: `${base(folder)}: ${files.length} photos`, total: files.length });
    let tiles = 0;
    const columnsTitle = `${base(folder)}  ·  ${files.length} photos`;
    await p.request({ type: 'sheetStart', columns, title: columnsTitle });
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Contact sheet', cancellable: true }, async (progress, token) => {
      for (let k = 0; k < files.length; k++) {
        if (token.isCancellationRequested || p.disposed) break;
        const f = files[k];
        const name = rel(folder, f);
        progress.report({ message: `${k + 1} of ${files.length}: ${name}`, increment: 100 / files.length });
        try {
          const s = await sourceOf(f, { maxSide: 480 });
          let sub = '';
          if (s.img) {
            const ex = s.img.exif(s.img.primaryIndex);
            const taken = ex ? (X.summary(ex.parsed).find((r) => r[0] === 'Taken') || [])[1] : '';
            const im = s.img.images[s.img.primaryIndex];
            sub = [taken ? String(taken).slice(0, 16) : '', im ? `${im.width} x ${im.height}` : ''].filter(Boolean).join(' · ');
          }
          await p.request({ type: 'tile', name, sub, src: s.src });
        } catch (e) {
          if (p.disposed) break;
          await p.request({ type: 'tile', name, sub: 'cannot be read', src: null }).catch(() => 0);
        }
        tiles++;
      }
    });
    if (p.disposed || !tiles) return undefined;
    const r = await p.request({ type: 'render', format: out.id === 'pdf' ? 'image/jpeg' : 'image/png' });
    const pages = r.pages || [];
    if (!pages.length) return undefined;
    const written = [];
    if (out.id === 'pdf') {
      const dest = await uniqueFile(folder, 'contact-sheet.pdf');
      await vscode.workspace.fs.writeFile(dest, makePdf(pages.map((x) => ({ jpeg: x.bytes, width: x.width, height: x.height })), `Contact sheet of ${base(folder)}`));
      written.push(dest);
    } else {
      for (let i = 0; i < pages.length; i++) {
        const dest = await uniqueFile(folder, pages.length === 1 ? 'contact-sheet.png' : `contact-sheet-${i + 1}.png`);
        await vscode.workspace.fs.writeFile(dest, Buffer.from(pages[i].bytes));
        written.push(dest);
      }
    }
    p.post({ type: 'done', text: `Saved ${written.map((u) => base(u)).join(', ')} in ${folder.fsPath}.` });
    await pro.produced('sheet');
    return { files: written, pages: pages.length, tiles };
  }

  // ---------- 3. Privacy check ----------
  async function scanAll(root, files) {
    const rows = [];
    for (const f of files) {
      let r;
      try { r = privacy.scan(await readBytes(f), base(f)); } catch (e) { r = { findings: [], camera: '', taken: '', canClean: false, error: String((e && e.message) || e) }; }
      const kinds = new Set(r.findings.map((x) => x.kind));
      rows.push({
        path: root ? rel(root, f) : base(f), uri: f.toString(), camera: r.camera, taken: r.taken,
        gps: (r.findings.find((x) => x.kind === 'gps') || {}).value || '',
        serial: r.findings.filter((x) => x.kind === 'serial').map((x) => `${x.label}: ${x.value}`).join('; '),
        owner: r.findings.filter((x) => x.kind === 'owner' || x.kind === 'id').map((x) => `${x.label}: ${x.value}`).join('; '),
        found: r.findings.length, kinds: [...kinds], canClean: r.canClean, error: r.error,
      });
    }
    return rows;
  }
  function privacyData(root, rows, note) {
    const withAny = rows.filter((r) => r.found > 0);
    return {
      kind: 'privacy', title: root ? `Privacy check: ${base(root)}` : 'Privacy check', note: note || '',
      totals: { files: rows.length, flagged: withAny.length, gps: rows.filter((r) => r.kinds.includes('gps')).length, serial: rows.filter((r) => r.kinds.includes('serial')).length, owner: rows.filter((r) => r.kinds.includes('owner') || r.kinds.includes('id')).length, unreadable: rows.filter((r) => r.error).length },
      rows: rows.map((r) => ({ path: r.path, camera: r.camera, taken: r.taken, gps: r.gps, serial: r.serial, owner: r.owner, found: r.found, error: r.error, canClean: r.canClean })),
    };
  }
  async function privacyTool(arg) {
    let target = activeUri(arg);
    if (!target) target = await pickFolder('Folder of photos to check');
    if (!target) return undefined;
    if (!(await pro.allowed('privacy', arg))) return undefined;
    const folder = (await isDir(target)) ? target : null;
    const files = folder ? await walk(folder, privacy.PRIVACY_RE) : [target];
    if (!files.length) { vscode.window.showInformationMessage(`No HEIC, HEIF, AVIF or JPEG photos in ${base(target)}.`); return undefined; }
    let rows = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: 'Privacy check' }, () => scanAll(folder, files));
    const byPath = new Map(files.map((f) => [folder ? rel(folder, f) : base(f), f]));
    const p = openPanel('privacy', folder ? `Privacy check: ${base(folder)}` : `Privacy check: ${base(target)}`);
    await p.ready;
    let counted = false;
    p.shown = async () => { if (!counted) { counted = true; await pro.produced('privacy'); } };
    const data = privacyData(folder, rows);
    p.actions = async (id) => {
      if (id === 'csv') {
        const dest = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.joinPath(folder || vscode.Uri.joinPath(target, '..'), 'privacy-check.csv'), filters: { CSV: ['csv'] } });
        if (!dest) return;
        const lines = ['path,gps,serial_numbers,owner_or_id,camera,taken,error'];
        for (const r of rows) lines.push([r.path, r.gps, r.serial, r.owner, r.camera, r.taken, r.error].map(csvCell).join(','));
        await vscode.workspace.fs.writeFile(dest, Buffer.from(lines.join('\n') + '\n', 'utf8'));
        vscode.window.setStatusBarMessage(`Saved ${base(dest)}`, 4000);
        return;
      }
      if (id !== 'strip' && id !== 'copies') return;
      const todo = rows.filter((r) => r.found > 0 && r.canClean);
      if (!todo.length) { vscode.window.showInformationMessage('Nothing to remove: no photo in the list holds a GPS position, serial number or owner name that can be cleaned.'); return; }
      if (id === 'strip') {
        const ok = await vscode.window.showWarningMessage(`Remove GPS positions, serial numbers and owner names from ${todo.length} photo${todo.length === 1 ? '' : 's'}? The files are changed in place; the image data stays exactly as it is.`, { modal: true }, 'Remove');
        if (ok !== 'Remove') return;
      }
      let done = 0;
      const errors = [];
      for (const r of todo) {
        const f = byPath.get(r.path);
        try {
          const res = privacy.clean(await readBytes(f), base(f));
          const dest = id === 'strip' ? f : await uniqueFile(vscode.Uri.joinPath(f, '..'), `${stem(base(f))}-clean${path.posix.extname(base(f))}`);
          await vscode.workspace.fs.writeFile(dest, res.bytes);
          done++;
        } catch (e) { errors.push(`${r.path}: ${(e && e.message) || e}`); }
      }
      rows = await scanAll(folder, files);
      const note = id === 'strip' ? `Removed from ${done} photo${done === 1 ? '' : 's'} in place.` : `Wrote ${done} cleaned cop${done === 1 ? 'y' : 'ies'} (name-clean) next to the originals.`;
      p.post({ type: 'data', data: privacyData(folder, rows, note + (errors.length ? ` ${errors.length} failed: ${errors.slice(0, 3).join('; ')}` : '')) });
    };
    p.post({ type: 'data', data });
    return data;
  }

  return { convertTool, sheetTool, privacyTool, sourceOf, panels };
}

module.exports = { createTools, FORMATS, SHEET_RE };
