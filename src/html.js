'use strict';
// Webview HTML for the HEIC and AVIF viewer and the Pro tool panels. No vscode import, so tests can check the CSP:
// no remote origin, no connect-src, scripts only with the page nonce. blob: images are allowed for AVIF decoding and
// the contact sheet preview.
const crypto = require('crypto');
const { footerHtml, FOOTER_CSS } = require('./support');

const PREFIX = 'heicViewer';
const attr = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function csp(cspSource, n) {
  return ["default-src 'none'", `style-src ${cspSource} 'nonce-${n}'`, `script-src 'nonce-${n}'`, `img-src ${cspSource} data: blob:`, `font-src ${cspSource}`].join('; ');
}

/** p: { cspSource, scriptUri, styleUri, title, showSupportLinks, head?(nonce) } */
function editorHtml(p) {
  const n = p.nonce || crypto.randomBytes(18).toString('base64url');
  const footer = footerHtml(PREFIX, p.showSupportLinks !== false, '');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp(p.cspSource, n)}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${attr(p.styleUri)}">
${footer ? `<style nonce="${n}">${FOOTER_CSS}</style>` : ''}
${typeof p.head === 'function' ? p.head(n) : ''}
<title>${attr(p.title)}</title>
</head>
<body>
<div id="toolbar" role="toolbar" aria-label="HEIC viewer">
  <span id="fmt" class="chip" title="Format, size and bit depth"></span>
  <label class="sel" id="imageBox" hidden>Image <select id="image" aria-label="Image in this file"></select></label>
  <span class="grp">
    <button class="tb" id="zoomOut" title="Zoom out (-)">-</button>
    <button class="tb" id="zoomLabel" title="Fit to the window, or 100 % when it already fits (0)">Fit</button>
    <button class="tb" id="zoomIn" title="Zoom in (+)">+</button>
    <button class="tb" id="actual" title="Actual size, 1 image pixel per screen pixel (1)">1:1</button>
  </span>
  <label class="sel">Background <select id="bg" aria-label="Background">
    <option value="checker">Checker</option><option value="black">Black</option><option value="gray">Gray</option><option value="white">White</option>
  </select></label>
  <button class="tb" id="infoBtn" title="Show or hide the info panel (I)" aria-pressed="true">Info</button>
</div>
<div id="err" role="alert" hidden></div>
<div id="busy" hidden>Decoding...</div>
<div id="main">
  <div id="stageWrap"><div id="stage" tabindex="0" aria-label="Image"><div id="pad"><canvas id="img"></canvas></div></div></div>
  <aside id="info" aria-label="Image information"></aside>
</div>
<div id="status"><span id="pos"></span><span id="pix"></span><span id="zoomPct"></span></div>
<div id="footer"></div>
<template id="zovo-footer">${footer}</template>
<script nonce="${n}" src="${attr(p.scriptUri)}"></script>
</body>
</html>`;
}

/** Panel of a Pro tool. p: { cspSource, scriptUri, styleUri, title, head?(nonce), showSupportLinks } */
function panelHtml(p) {
  const n = p.nonce || crypto.randomBytes(18).toString('base64url');
  const footer = footerHtml(PREFIX, p.showSupportLinks !== false, '');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp(p.cspSource, n)}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${attr(p.styleUri)}">
${footer ? `<style nonce="${n}">${FOOTER_CSS}</style>` : ''}
${typeof p.head === 'function' ? p.head(n) : ''}
<title>${attr(p.title)}</title>
</head>
<body>
<div id="toolbar" role="toolbar"><strong id="title"></strong><span id="actions"></span></div>
<div id="app"><p class="muted">Working...</p></div>
<div id="footer">${footer}</div>
<script nonce="${n}" src="${attr(p.scriptUri)}"></script>
</body>
</html>`;
}

module.exports = { editorHtml, panelHtml, csp };
