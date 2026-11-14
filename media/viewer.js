// HEIC and AVIF viewer webview. HEIC pixels arrive decoded (RGBA) from the extension host; AVIF files arrive as bytes
// and are decoded here by the editor's own image decoder (createImageBitmap). Zoom, pan, the color under the cursor,
// a background switch, an image picker for multi-image files and an info panel with the EXIF and the GPS numbers.
// No network access (CSP default-src 'none'): no map, no tiles, no fonts; the only messages go to the extension host.
(function () {
  'use strict';
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  const state = Object.assign({ zoom: 0, fit: true, bg: 'checker', info: true, tags: false }, vscode.getState() || {});
  let meta = null, info = null, img = null, current = 0;
  let canvas = $('img'), ctx = null;
  const stage = $('stage');
  const save = () => vscode.setState({ zoom: state.zoom, fit: state.fit, bg: state.bg, info: state.info, tags: state.tags });
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  const tpl = $('zovo-footer');
  if (tpl && tpl.innerHTML.trim()) $('footer').innerHTML = tpl.innerHTML;
  $('bg').value = state.bg;
  applyInfo();

  function showError(text) { const e = $('err'); e.textContent = text; e.hidden = !text; }
  function busy(on) { $('busy').hidden = !on; }

  function onMeta(m) {
    meta = m;
    showError('');
    if (m.error) { showError(m.error); $('fmt').textContent = 'Cannot open'; busy(false); renderInfo(); return; }
    const s = $('image'); s.textContent = '';
    for (const im of m.images) { const o = document.createElement('option'); o.value = String(im.index); o.textContent = `${im.label}: ${im.width} x ${im.height}`; s.appendChild(o); }
    $('imageBox').hidden = m.images.length <= 1 || m.kind === 'avif';
    current = m.current;
    s.value = String(current);
    chip();
    renderInfo();
  }
  function chip() {
    if (!meta || !meta.images.length) { $('fmt').textContent = meta ? meta.kind.toUpperCase() : ''; return; }
    const im = meta.images[current] || meta.images[0];
    $('fmt').textContent = `${meta.kind.toUpperCase()} · ${im.width} x ${im.height}${im.bitDepth ? ` · ${im.bitDepth}-bit` : ''}${im.hdr ? ' · HDR' : ''}`;
  }

  /** A fresh canvas, so the color space can follow the image (Display P3 photos keep their colors). */
  function newCanvas(w, h, p3) {
    const c = document.createElement('canvas');
    c.id = 'img';
    c.width = w; c.height = h;
    c.className = `bg-${state.bg}`;
    canvas.replaceWith(c);
    canvas = c;
    try { ctx = c.getContext('2d', p3 ? { colorSpace: 'display-p3' } : undefined); } catch (e) { ctx = c.getContext('2d'); }
    if (!ctx) ctx = c.getContext('2d');
    return ctx;
  }

  function onImage(m) {
    if (m.index !== undefined) current = m.index;
    $('image').value = String(current);
    busy(false);
    chip();
    if (m.error) { img = null; newCanvas(0, 0, false); showError(m.error); vscode.postMessage({ type: 'failed', error: m.error }); return; }
    showError('');
    const rgba = m.rgba instanceof Uint8ClampedArray ? m.rgba : new Uint8ClampedArray(m.rgba.buffer || m.rgba, m.rgba.byteOffset || 0, m.rgba.byteLength || m.rgba.length);
    const c = newCanvas(m.width, m.height, !!m.p3);
    let data;
    try { data = new ImageData(rgba, m.width, m.height, m.p3 ? { colorSpace: 'display-p3' } : undefined); } catch (e) { data = new ImageData(rgba, m.width, m.height); }
    c.putImageData(data, 0, 0);
    img = { width: m.width, height: m.height, rgba };
    done();
  }

  async function onAvif(m) {
    current = m.index || 0;
    busy(true);
    chip();
    try {
      const blob = new Blob([m.bytes], { type: m.mime || 'image/avif' });
      const bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' });
      const c = newCanvas(bmp.width, bmp.height, !!m.p3);
      c.drawImage(bmp, 0, 0);
      if (bmp.close) bmp.close();
      let px;
      try { px = c.getImageData(0, 0, canvas.width, canvas.height).data; } catch (e) { px = new Uint8ClampedArray(canvas.width * canvas.height * 4); }
      img = { width: canvas.width, height: canvas.height, rgba: px };
      const cur = meta && meta.images[current];
      if (cur && !cur.width) { cur.width = img.width; cur.height = img.height; }
      chip();
      showError('');
      busy(false);
      done();
    } catch (e) {
      busy(false);
      img = null;
      newCanvas(0, 0, false);
      const why = m.mime && m.mime !== 'image/avif' ? 'This image could not be decoded.' : 'The AVIF decoder of this editor could not read this image. The file details are shown on the right.';
      showError(why);
      vscode.postMessage({ type: 'failed', error: why });
    }
  }


  function done() {
    if (state.fit) fitZoom(); else applyZoom();
    vscode.postMessage({ type: 'shown', index: current, width: img.width, height: img.height });
    attachPointer();
  }

  // ---------- zoom and pan ----------
  const LEVELS = [1 / 32, 1 / 16, 1 / 12, 1 / 8, 1 / 6, 1 / 4, 1 / 3, 1 / 2, 2 / 3, 1, 1.5, 2, 3, 4, 6, 8, 12, 16, 24, 32];
  function fitScale() {
    if (!img) return 1;
    const r = stage.getBoundingClientRect();
    const s = Math.min((r.width - 24) / img.width, (r.height - 24) / img.height);
    return s >= 1 ? 1 : Math.max(s, 1 / 64);
  }
  function fitZoom() { state.fit = true; state.zoom = fitScale(); applyZoom(); }
  function applyZoom(anchor) {
    if (!img) { $('zoomPct').textContent = ''; return; }
    const z = state.zoom || 1;
    const before = anchor ? { x: (stage.scrollLeft + anchor.x) / (canvas.clientWidth || 1), y: (stage.scrollTop + anchor.y) / (canvas.clientHeight || 1) } : null;
    canvas.style.width = `${img.width * z}px`;
    canvas.style.height = `${img.height * z}px`;
    canvas.style.imageRendering = z >= 2 ? 'pixelated' : 'auto';
    if (before) { stage.scrollLeft = before.x * img.width * z - anchor.x; stage.scrollTop = before.y * img.height * z - anchor.y; }
    $('zoomPct').textContent = `${Math.round(z * 1000) / 10} %`;
    $('zoomLabel').textContent = state.fit ? 'Fit' : `${Math.round(z * 100)} %`;
    save();
  }
  function step(dir, anchor) {
    const z = state.zoom || 1;
    let n = dir > 0 ? LEVELS.find((l) => l > z * 1.001) : [...LEVELS].reverse().find((l) => l < z / 1.001);
    if (!n) n = z;
    state.fit = false; state.zoom = n; applyZoom(anchor);
  }
  $('zoomIn').onclick = () => step(1);
  $('zoomOut').onclick = () => step(-1);
  $('actual').onclick = () => { state.fit = false; state.zoom = 1; applyZoom(); };
  $('zoomLabel').onclick = () => { if (state.fit && Math.abs(state.zoom - 1) > 1e-6) { state.fit = false; state.zoom = 1; applyZoom(); } else fitZoom(); };
  stage.addEventListener('wheel', (e) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    const r = stage.getBoundingClientRect();
    step(e.deltaY < 0 ? 1 : -1, { x: e.clientX - r.left, y: e.clientY - r.top });
  }, { passive: false });
  let drag = null;
  stage.addEventListener('mousedown', (e) => { if (e.button !== 0) return; drag = { x: e.clientX, y: e.clientY, l: stage.scrollLeft, t: stage.scrollTop }; stage.classList.add('drag'); });
  window.addEventListener('mouseup', () => { drag = null; stage.classList.remove('drag'); });
  window.addEventListener('mousemove', (e) => { if (drag) { stage.scrollLeft = drag.l - (e.clientX - drag.x); stage.scrollTop = drag.t - (e.clientY - drag.y); } });
  window.addEventListener('resize', () => { if (state.fit) fitZoom(); });

  // ---------- color under the cursor ----------
  const hex2 = (v) => v.toString(16).padStart(2, '0').toUpperCase();
  function pixelAt(e) {
    if (!img) return null;
    const cr = canvas.getBoundingClientRect();
    const x = Math.floor((e.clientX - cr.left) / (cr.width / img.width)), y = Math.floor((e.clientY - cr.top) / (cr.height / img.height));
    if (x < 0 || y < 0 || x >= img.width || y >= img.height) return null;
    const i = (y * img.width + x) * 4;
    return { x, y, r: img.rgba[i], g: img.rgba[i + 1], b: img.rgba[i + 2], a: img.rgba[i + 3] };
  }
  function showPixel(t) {
    if (!t) { $('pos').textContent = img ? `${img.width} x ${img.height} px` : ''; $('pix').textContent = ''; return; }
    $('pos').textContent = `x ${t.x}, y ${t.y}`;
    const pix = $('pix'); pix.textContent = '';
    const sw = document.createElement('span'); sw.className = 'sw'; sw.style.background = `rgb(${t.r},${t.g},${t.b})`;
    pix.appendChild(sw); pix.appendChild(document.createTextNode(`RGB ${t.r} ${t.g} ${t.b}${t.a < 255 ? ` A ${t.a}` : ''}  #${hex2(t.r)}${hex2(t.g)}${hex2(t.b)}`));
  }
  function attachPointer() { showPixel(null); }
  stage.addEventListener('mousemove', (e) => showPixel(pixelAt(e)));
  stage.addEventListener('mouseleave', () => showPixel(null));
  stage.addEventListener('dblclick', (e) => { const t = pixelAt(e); if (t) vscode.postMessage({ type: 'copy', text: `#${hex2(t.r)}${hex2(t.g)}${hex2(t.b)}` }); });
  stage.title = 'Drag to pan, Ctrl or Cmd + wheel to zoom, double-click to copy the color';

  // ---------- toolbar ----------
  function pick(i) {
    if (!meta || !meta.images[i] || i === current && img) return;
    current = i;
    $('image').value = String(i);
    busy(true);
    chip();
    vscode.postMessage({ type: 'select', index: i });
  }
  $('image').onchange = () => pick(Number($('image').value));
  $('bg').onchange = () => { state.bg = $('bg').value; save(); canvas.className = `bg-${state.bg}`; };
  $('infoBtn').onclick = () => { state.info = !state.info; save(); applyInfo(); if (state.fit) fitZoom(); };
  function applyInfo() { $('info').hidden = !state.info; $('infoBtn').setAttribute('aria-pressed', String(!!state.info)); }
  document.addEventListener('keydown', (e) => {
    if (e.target && /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName)) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.key;
    const n = meta ? meta.images.length : 0;
    if (k === '+' || k === '=') step(1); else if (k === '-') step(-1); else if (k === '0') fitZoom(); else if (k === '1') { state.fit = false; state.zoom = 1; applyZoom(); }
    else if (k === 'i' || k === 'I') $('infoBtn').click();
    else if ((k === 'ArrowRight' || k === 'PageDown') && n > 1 && meta.kind !== 'avif') pick((current + 1) % n);
    else if ((k === 'ArrowLeft' || k === 'PageUp') && n > 1 && meta.kind !== 'avif') pick((current - 1 + n) % n);
    else return;
    e.preventDefault();
  });

  // ---------- info panel ----------
  const table = (rows) => `<table>${rows.map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`).join('')}</table>`;
  function renderInfo() {
    const box = $('info');
    if (!meta) { box.textContent = ''; return; }
    if (meta.error && !meta.fileRows) { box.innerHTML = `<h3>Cannot open this file</h3><p>${esc(meta.error)}</p>`; return; }
    const parts = [`<h3 class="name">${esc(meta.name)}</h3>`];
    if (info) {
      if (info.image.length) parts.push(`<h3>Image</h3>${table(info.image)}`);
      if (info.camera.length) parts.push(`<h3>Camera</h3>${table(info.camera)}`);
      if (info.gps) {
        const g = info.gps;
        const rows = [['Latitude', `${g.lat} (${g.latText})`], ['Longitude', `${g.lon} (${g.lonText})`]];
        if (g.alt !== undefined) rows.push(['Altitude', `${g.alt} m`]);
        if (g.direction !== undefined) rows.push(['Direction', `${g.direction}°`]);
        if (g.time) rows.push(['GPS time', g.time]);
        parts.push(`<h3>Location</h3>${table(rows)}<p class="muted">Numbers only. No map is loaded, so nothing leaves this computer.</p><p><button class="tb" id="copyGps">Copy coordinates</button></p>`);
      }
      if (info.privacy.length) {
        parts.push(`<h3>Privacy</h3><ul class="priv">${info.privacy.map((p) => `<li>${esc(p.label)}: ${esc(p.value)}</li>`).join('')}</ul>`
          + (meta.privacyTool ? '<p><button class="tb" id="privTool" title="Zovo Pro tool: lists these fields in every photo of a folder and removes them">Remove with Privacy check (Pro)</button></p>' : ''));
      }
      parts.push(`<h3>File</h3>${table(meta.fileRows || [])}`);
      if (info.tags.length) parts.push(`<details id="tagsBox"${state.tags ? ' open' : ''}><summary>All EXIF tags (${info.tags.length})</summary><table class="tags">${info.tags.map((t) => `<tr><th>${esc(t.ifd)}</th><td>${esc(t.name)}</td><td>${esc(t.value)}</td></tr>`).join('')}</table></details>`);
    } else if (meta.fileRows) parts.push(`<h3>File</h3>${table(meta.fileRows)}`);
    if (meta.warnings && meta.warnings.length) parts.push(`<h3>Notes</h3><ul>${meta.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>`);
    parts.push('<p><button class="tb" id="copyInfo">Copy info</button></p>');
    box.innerHTML = parts.join('');
    const cg = $('copyGps');
    if (cg) cg.onclick = () => vscode.postMessage({ type: 'copy', text: `${info.gps.lat}, ${info.gps.lon}` });
    const pt = $('privTool');
    if (pt) pt.onclick = () => vscode.postMessage({ type: 'command', id: meta.privacyTool });
    const tb = $('tagsBox');
    if (tb) tb.ontoggle = () => { state.tags = tb.open; save(); };
    $('copyInfo').onclick = () => {
      const lines = [meta.name];
      const add = (title, rows) => { if (rows && rows.length) { lines.push('', title); for (const [k, v] of rows) lines.push(`${k}: ${v}`); } };
      if (info) { add('Image', info.image); add('Camera', info.camera); if (info.gps) add('Location', [['Latitude', String(info.gps.lat)], ['Longitude', String(info.gps.lon)]]); }
      add('File', meta.fileRows);
      vscode.postMessage({ type: 'copy', text: lines.join('\n') });
    };
  }

  window.addEventListener('message', (e) => {
    const m = e.data;
    if (!m || typeof m !== 'object') return;
    if (m.type === 'meta') onMeta(m);
    else if (m.type === 'info') { info = m; renderInfo(); }
    else if (m.type === 'image') onImage(m);
    else if (m.type === 'avif') onAvif(m);
    else if (m.type === 'busy') busy(true);
  });
  busy(true);
  vscode.postMessage({ type: 'ready' });
})();
