'use strict';
// Read-only custom editor for .heic, .heif, .hif and .avif. The extension host reads the file, parses the container
// and the EXIF (src/core), decodes HEIC images in a worker thread with libheif and sends RGBA to the webview. AVIF
// files go to the webview as bytes and the editor's own image decoder draws them. Nothing leaves the computer; the
// webview has no network access (CSP default-src 'none').
const vscode = require('vscode');
const path = require('path');
const { openImage, describe } = require('./core/heif');
const { editorHtml } = require('./html');
const support = require('./support');

const VIEW_TYPE = 'heicViewer.editor';
// AVIF has its own view type with priority "option": VS Code's built-in image preview also opens .avif, and two
// default editors would make VS Code ask the user which one to use on every first open.
const AVIF_VIEW_TYPE = 'heicViewer.avif';
const viewTypeFor = (uri) => (/\.avif$/i.test(uri.path) ? AVIF_VIEW_TYPE : VIEW_TYPE);
const PREFIX = 'heicViewer';
const setting = (k, d) => vscode.workspace.getConfiguration(PREFIX).get(k, d);

/** A file with a HEIC name that is really a JPEG or PNG (some phones and converters do this). */
function sniffOther(b) {
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  return '';
}

class HeicDocument {
  constructor(uri) { this.uri = uri; this.bytes = null; this.img = null; this.error = ''; this.other = ''; this.current = 0; this.panels = new Set(); this.listeners = []; }
  get name() { return path.posix.basename(this.uri.path); }
  async load() {
    this.img = null; this.error = ''; this.other = ''; this.bytes = null;
    try {
      const stat = await vscode.workspace.fs.stat(this.uri);
      const max = Math.max(1, Number(setting('maxFileSizeMB', 300)) || 300);
      if (stat.size > max * 1024 * 1024) { this.error = `This file is ${(stat.size / 1048576).toFixed(0)} MB, more than the ${max} MB set in "heicViewer.maxFileSizeMB".`; return; }
      const data = await vscode.workspace.fs.readFile(this.uri);
      this.bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      this.other = sniffOther(this.bytes);
      if (this.other) return;
      this.img = openImage(this.bytes, this.name);
      this.current = Math.min(this.current, Math.max(0, this.img.images.length - 1)) || this.img.primaryIndex;
    } catch (e) {
      this.error = String((e && e.message) || e);
    }
  }
  dispose() { for (const l of this.listeners) l.dispose(); }
}

function metaOf(doc, extra = {}) {
  const base = { type: 'meta', name: doc.name, ...extra };
  if (doc.other) {
    return { ...base, kind: doc.other === 'image/jpeg' ? 'jpeg' : 'png', images: [{ index: 0, label: 'Image 1 of 1', width: 0, height: 0 }], current: 0, fileRows: [['File size', `${doc.bytes.length.toLocaleString('en-US')} bytes`]], warnings: [`This file has a HEIC or AVIF name, but it is really a ${doc.other === 'image/jpeg' ? 'JPEG' : 'PNG'} image.`] };
  }
  if (!doc.img) return { ...base, error: doc.error || 'The file could not be read.' };
  const img = doc.img;
  return {
    ...base, kind: img.kind, current: doc.current, fileRows: img.fileRows, warnings: img.warnings,
    images: img.images.map((im) => ({ index: im.index, label: im.label, width: im.width, height: im.height, bitDepth: im.bitDepth, hdr: im.hdr })),
  };
}

class HeicEditorProvider {
  constructor(context, hooks = {}) {
    this.context = context;
    this.hooks = hooks;
    this.docs = new Set();
    this.active = null;
    this._success = new WeakSet();
  }
  decoder() { return this.hooks.decoder(); }

  async openCustomDocument(uri) {
    const doc = new HeicDocument(uri);
    await doc.load();
    this.docs.add(doc);
    if (uri.scheme === 'file') {
      try {
        const w = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.joinPath(uri, '..'), path.posix.basename(uri.path)));
        let timer = null;
        const reload = () => { clearTimeout(timer); timer = setTimeout(async () => { await doc.load(); for (const p of doc.panels) this.post(doc, p.webview); }, 250); };
        doc.listeners.push(w, w.onDidChange(reload), w.onDidCreate(reload));
      } catch (e) { /* no watcher: the view still works */ }
    }
    return { uri, dispose: () => { this.docs.delete(doc); doc.dispose(); if (this.active === doc) this.active = null; }, _doc: doc };
  }

  async resolveCustomEditor(handle, panel) {
    const doc = handle._doc;
    doc.panels.add(panel);
    const media = vscode.Uri.joinPath(this.context.extensionUri, 'media');
    const reach = this.hooks.reach ? this.hooks.reach() : null;
    panel.webview.options = {
      enableScripts: true, localResourceRoots: [media],
      enableCommandUris: (reach ? reach.commandIds() : []).concat(support.commandUris(PREFIX)),
    };
    panel.webview.html = editorHtml({
      cspSource: panel.webview.cspSource,
      scriptUri: panel.webview.asWebviewUri(vscode.Uri.joinPath(media, 'viewer.js')).toString(),
      styleUri: panel.webview.asWebviewUri(vscode.Uri.joinPath(media, 'viewer.css')).toString(),
      title: doc.name,
      head: reach ? (n) => reach.headHtml(n) : undefined,
      showSupportLinks: setting('showSupportLinks', true) !== false,
    });
    if (reach) reach.attach(panel.webview, panel);
    const setActive = () => { if (panel.active) { this.active = doc; this.activePanel = panel; } };
    setActive();
    panel.onDidChangeViewState(setActive);
    panel.onDidDispose(() => { doc.panels.delete(panel); if (this.activePanel === panel) { this.activePanel = null; if (this.active === doc) this.active = null; } });
    panel.webview.onDidReceiveMessage(async (m) => {
      if (reach && reach.onMessage(m)) return;
      if (!m || typeof m !== 'object') return;
      if (m.type === 'ready') await this.post(doc, panel.webview);
      else if (m.type === 'select') { if (doc.img && doc.img.images[m.index | 0]) { doc.current = m.index | 0; await this.postImage(doc, panel.webview); } }
      else if (m.type === 'shown') { if (!this._success.has(doc)) { this._success.add(doc); if (this.hooks.onSuccess) this.hooks.onSuccess(doc); } }
      else if (m.type === 'failed') { if (this.hooks.onFailure) this.hooks.onFailure(doc); }
      else if (m.type === 'copy' && typeof m.text === 'string') { await vscode.env.clipboard.writeText(m.text.slice(0, 20000)); vscode.window.setStatusBarMessage(`Copied ${m.text.length > 40 ? 'the image info' : m.text}`, 3000); }
      else if (m.type === 'command' && typeof m.id === 'string' && /^heicViewer\.(convert|sheet|privacy)$/.test(m.id)) vscode.commands.executeCommand(m.id, { surface: 'toolbar' });
    });
  }

  send(webview, msg) { try { const r = webview.postMessage(msg); if (r && r.then) r.then(undefined, () => false); } catch (e) { /* disposed */ } }

  /** Sends meta, the info of the current image and the image itself. */
  async post(doc, webview) {
    const showPro = setting('showProTools', true) !== false;
    this.send(webview, metaOf(doc, { privacyTool: showPro ? 'heicViewer.privacy' : '' }));
    if (doc.other) { this.send(webview, { type: 'avif', index: 0, bytes: doc.bytes.slice(), mime: doc.other }); return; }
    if (!doc.img) { if (this.hooks.onFailure) this.hooks.onFailure(doc); return; }
    await this.postImage(doc, webview);
  }

  async postImage(doc, webview) {
    const img = doc.img;
    const i = doc.current;
    this.send(webview, { type: 'info', ...describe(img, i) });
    const im = img.images[i];
    if (!im) { this.send(webview, { type: 'image', index: i, error: img.container.sequence ? 'This file holds only an image sequence (a short video track). The viewer opens still images.' : 'This file lists no image.' }); return; }
    if (!img.decodable(i)) { this.send(webview, { type: 'image', index: i, error: im.type === 'vvc1' ? 'This image uses the VVC (H.266) codec, which this viewer cannot decode yet. The file details are shown on the right.' : `This image uses ${im.codec}, which this viewer cannot decode. The file details are shown on the right.` }); return; }
    if (img.kind === 'avif') { this.send(webview, { type: 'avif', index: i, bytes: doc.bytes.slice(), p3: im.p3, mime: 'image/avif' }); return; }
    this.send(webview, { type: 'busy' });
    const r = await this.decoder().decodeHeic({ bytes: doc.bytes, itemId: im.id });
    if (doc.current !== i) return; // the user picked another image meanwhile
    if (r.error) { this.send(webview, { type: 'image', index: i, error: r.error }); return; }
    this.send(webview, { type: 'image', index: i, width: r.width, height: r.height, rgba: r.rgba, p3: im.p3 });
  }
}

module.exports = { HeicEditorProvider, HeicDocument, VIEW_TYPE, AVIF_VIEW_TYPE, viewTypeFor, metaOf, sniffOther };
