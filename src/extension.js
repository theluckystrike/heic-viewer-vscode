'use strict';
// HEIC Viewer & AVIF Viewer by Zovo: opens .heic, .heif, .hif and .avif images in a VS Code editor tab. No network,
// no telemetry. Activation shows nothing: no message, no popup. The viewer opens only for files the user opens.
const vscode = require('vscode');
const { HeicEditorProvider, VIEW_TYPE, AVIF_VIEW_TYPE, viewTypeFor } = require('./editor');
const { createDecoder } = require('./core/decoder');
const { createTools } = require('./tools');
const { createPro } = require('./pro');
const { createRatingPrompt } = require('./rate');
const support = require('./support');
const { createReach } = require('./reach');
const reachConfig = require('./reach-config');

const PREFIX = 'heicViewer';
const EXT_ID = 'zovo.zovo-heic-viewer';
const setting = (k, d) => vscode.workspace.getConfiguration(PREFIX).get(k, d);

function activate(context) {
  const sub = (d) => context.subscriptions.push(d);
  let rating = { success() {}, failure() {} };
  try { rating = createRatingPrompt({ vscode, context, extensionId: EXT_ID, section: PREFIX, name: 'HEIC Viewer' }); } catch (e) { /* rating is optional */ }
  support.registerSupport({ vscode, context, prefix: PREFIX, selfId: EXT_ID });
  const pro = createPro({ vscode, context });
  const reach = createReach({ vscode, ...reachConfig, context, licensed: () => !!pro.licensed, shown: () => setting('showProTools', true) !== false });
  reach.registerCtx();
  sub(pro.onDidChange(() => reach.refresh()));

  // One decoder worker for the window, started on the first HEIC and ended when idle.
  let decoder = null;
  const getDecoder = () => decoder || (decoder = createDecoder());
  sub({ dispose: () => { if (decoder) decoder.stop(); } });

  const provider = new HeicEditorProvider(context, {
    reach: () => reach,
    decoder: getDecoder,
    onSuccess: (doc) => rating.success(doc.uri),
    onFailure: () => rating.failure(),
  });
  for (const vt of [VIEW_TYPE, AVIF_VIEW_TYPE]) sub(vscode.window.registerCustomEditorProvider(vt, provider, { webviewOptions: { retainContextWhenHidden: true }, supportsMultipleEditorsPerDocument: true }));
  const tools = createTools({ context, provider, pro, reach, decoder: getDecoder });

  const reg = (id, fn) => sub(vscode.commands.registerCommand(id, async (...a) => {
    try { return await fn(...a); } catch (e) { vscode.window.showErrorMessage(String((e && e.message) || e)); return undefined; }
  }));
  const target = (uri) => (uri && uri.scheme ? uri : (uri && uri.surface ? uri : undefined));
  reg(`${PREFIX}.openWithViewer`, (uri) => {
    const u = uri && uri.scheme ? uri : (vscode.window.activeTextEditor && vscode.window.activeTextEditor.document.uri);
    if (!u) { vscode.window.showInformationMessage('Select a .heic, .heif or .avif file first.'); return undefined; }
    return vscode.commands.executeCommand('vscode.openWith', u, viewTypeFor(u));
  });
  reg(`${PREFIX}.openSample`, () => vscode.commands.executeCommand('vscode.openWith', vscode.Uri.joinPath(context.extensionUri, 'samples', 'sample-wind-farm.heic'), VIEW_TYPE));
  reg(`${PREFIX}.openAvifSample`, () => vscode.commands.executeCommand('vscode.openWith', vscode.Uri.joinPath(context.extensionUri, 'samples', 'sample-wind-farm.avif'), AVIF_VIEW_TYPE));
  reg(`${PREFIX}.openWalkthrough`, () => vscode.commands.executeCommand('workbench.action.openWalkthrough', `${EXT_ID}#${PREFIX}.start`, false));
  reg(`${PREFIX}.convert`, reach.wrap((uri, uris) => tools.convertTool(target(uri), uris)));
  reg(`${PREFIX}.sheet`, reach.wrap((uri) => tools.sheetTool(target(uri))));
  reg(`${PREFIX}.privacy`, reach.wrap((uri) => tools.privacyTool(target(uri))));
  sub(vscode.workspace.onDidChangeConfiguration((e) => { if (e.affectsConfiguration(`${PREFIX}.showProTools`)) reach.refresh(); }));
  sub(vscode.window.registerUriHandler({ handleUri: (uri) => pro.handleUri(uri) }));
  return { provider, tools, pro, decoder: getDecoder };
}

function deactivate() {}

module.exports = { activate, deactivate };
