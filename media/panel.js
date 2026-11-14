// Pro tool panel. Does the image work that needs the editor's own codecs: decodes AVIF (and JPEG, PNG, WebP) with
// createImageBitmap, scales, encodes JPEG, PNG and WebP with OffscreenCanvas.convertToBlob, and lays out contact
// sheet pages. Shows the convert progress, the contact sheet preview and the privacy table. Every request from the
// extension host gets one 'reply' message with the same id. No network access (CSP default-src 'none').
(function () {
  'use strict';
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const reply = (id, body) => vscode.postMessage(Object.assign({ type: 'reply', id }, body));
  let kind = '';

  // ---------- pixels ----------
  async function bitmapOf(src) {
    if (src.rgba) {
      const data = src.rgba instanceof Uint8ClampedArray ? src.rgba : new Uint8ClampedArray(src.rgba.buffer || src.rgba, src.rgba.byteOffset || 0, src.rgba.byteLength || src.rgba.length);
      return createImageBitmap(new ImageData(data, src.width, src.height));
    }
    return createImageBitmap(new Blob([src.bytes], { type: src.mime || 'image/avif' }), { imageOrientation: 'from-image' });
  }
  /** Draws bmp into a canvas whose longer side is at most maxSide (0 = no limit), halving in steps for a clean result. */
  function scaled(bmp, maxSide) {
    let w = bmp.width, h = bmp.height;
    const s = maxSide && Math.max(w, h) > maxSide ? maxSide / Math.max(w, h) : 1;
    const W = Math.max(1, Math.round(w * s)), H = Math.max(1, Math.round(h * s));
    let cur = bmp;
    while (w / 2 >= W * 1.5 && h / 2 >= H * 1.5) {
      const c = new OffscreenCanvas(Math.round(w / 2), Math.round(h / 2));
      const x = c.getContext('2d'); x.imageSmoothingQuality = 'high'; x.drawImage(cur, 0, 0, c.width, c.height);
      cur = c; w = c.width; h = c.height;
    }
    const c = new OffscreenCanvas(W, H);
    const x = c.getContext('2d'); x.imageSmoothingQuality = 'high'; x.drawImage(cur, 0, 0, W, H);
    return c;
  }
  async function encode(m) {
    const bmp = await bitmapOf(m.src);
    let c = scaled(bmp, m.maxSide || 0);
    if (bmp.close) bmp.close();
    if (m.mime === 'image/jpeg') {
      // JPEG has no alpha: put transparent parts on white instead of black.
      const w = new OffscreenCanvas(c.width, c.height);
      const x = w.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, w.width, w.height); x.drawImage(c, 0, 0);
      c = w;
    }
    const blob = await c.convertToBlob({ type: m.mime, quality: m.quality });
    if (blob.type !== m.mime) throw new Error(`This editor cannot write ${m.mime.replace('image/', '').toUpperCase()} files.`);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    return { bytes, width: c.width, height: c.height };
  }

  // ---------- convert ----------
  let convertRows = [];
  function renderConvert(title, total) {
    $('title').textContent = title;
    $('actions').textContent = '';
    convertRows = [];
    $('app').innerHTML = `<p id="sum" class="muted">0 of ${total} done</p><table class="grid"><thead><tr><th>Source</th><th>Result</th><th>Output</th><th>Size</th><th>Metadata</th></tr></thead><tbody id="rows"></tbody></table><p id="doneText"></p>`;
    $('sum').dataset.total = String(total);
  }
  function addRow(r) {
    convertRows.push(r);
    const tr = document.createElement('tr');
    if (!r.ok) tr.className = 'has-warn';
    tr.innerHTML = r.ok ? `<td>${esc(r.path)}</td><td>converted</td><td>${esc(r.out)}</td><td class="num">${r.width} x ${r.height}, ${esc(r.size)}</td><td>${esc(r.metadata)}</td>` : `<td>${esc(r.path)}</td><td>skipped</td><td colspan="3">${esc(r.reason)}</td>`;
    $('rows').appendChild(tr);
    const ok = convertRows.filter((x) => x.ok).length;
    $('sum').textContent = `${convertRows.length} of ${$('sum').dataset.total} done, ${ok} converted`;
  }

  // ---------- contact sheet ----------
  const PAGE = { w: 1240, h: 1754, margin: 60, head: 70, gap: 24, label: 44 };
  let sheet = null;
  function startSheet(m) {
    sheet = { columns: m.columns || 4, title: m.title || 'Contact sheet', tiles: [] };
    $('title').textContent = 'Contact sheet';
    $('actions').textContent = '';
    $('app').innerHTML = `<p id="sum" class="muted">Reading photos...</p><div id="thumbs" class="thumbs"></div><div id="pages" class="tiles"></div><p id="doneText"></p>`;
  }
  async function addTile(m) {
    const cell = (PAGE.w - PAGE.margin * 2 - PAGE.gap * (sheet.columns - 1)) / sheet.columns;
    let canvas = null;
    if (m.src) {
      try { const bmp = await bitmapOf(m.src); canvas = scaled(bmp, Math.ceil(cell * 1.5)); if (bmp.close) bmp.close(); } catch (e) { canvas = null; }
    }
    sheet.tiles.push({ name: m.name, sub: canvas ? m.sub : 'cannot be read', canvas });
    $('sum').textContent = `${sheet.tiles.length} photos read`;
  }
  function fitText(x, text, max) {
    if (x.measureText(text).width <= max) return text;
    let t = text;
    while (t.length > 3 && x.measureText(`...${t}`).width > max) t = t.slice(1);
    return `...${t}`;
  }
  async function renderSheet(m) {
    const cols = sheet.columns;
    const cell = (PAGE.w - PAGE.margin * 2 - PAGE.gap * (cols - 1)) / cols;
    const rowH = cell + PAGE.label + PAGE.gap;
    const rows = Math.max(1, Math.floor((PAGE.h - PAGE.margin * 2 - PAGE.head + PAGE.gap) / rowH));
    const per = rows * cols;
    const n = Math.max(1, Math.ceil(sheet.tiles.length / per));
    const pages = [];
    $('pages').textContent = '';
    for (let pg = 0; pg < n; pg++) {
      const c = new OffscreenCanvas(PAGE.w, PAGE.h);
      const x = c.getContext('2d');
      x.fillStyle = '#fff'; x.fillRect(0, 0, PAGE.w, PAGE.h);
      x.fillStyle = '#222'; x.font = '600 26px system-ui, sans-serif'; x.textBaseline = 'top';
      x.fillText(fitText(x, sheet.title, PAGE.w - PAGE.margin * 2 - 140), PAGE.margin, PAGE.margin);
      x.font = '20px system-ui, sans-serif'; x.fillStyle = '#666';
      const pl = `Page ${pg + 1} of ${n}`; x.fillText(pl, PAGE.w - PAGE.margin - x.measureText(pl).width, PAGE.margin + 4);
      const slice = sheet.tiles.slice(pg * per, pg * per + per);
      slice.forEach((t, k) => {
        const cx = PAGE.margin + (k % cols) * (cell + PAGE.gap), cy = PAGE.margin + PAGE.head + Math.floor(k / cols) * rowH;
        x.fillStyle = '#f2f2f2'; x.fillRect(cx, cy, cell, cell);
        if (t.canvas) {
          const s = Math.min(cell / t.canvas.width, cell / t.canvas.height);
          const w = t.canvas.width * s, h = t.canvas.height * s;
          x.imageSmoothingQuality = 'high';
          x.drawImage(t.canvas, cx + (cell - w) / 2, cy + (cell - h) / 2, w, h);
        } else { x.fillStyle = '#999'; x.font = '18px system-ui, sans-serif'; x.fillText('cannot be read', cx + 12, cy + cell / 2 - 9); }
        x.fillStyle = '#222'; x.font = '16px system-ui, sans-serif';
        x.fillText(fitText(x, t.name, cell), cx, cy + cell + 6);
        x.fillStyle = '#777'; x.font = '14px system-ui, sans-serif';
        x.fillText(fitText(x, t.sub || '', cell), cx, cy + cell + 26);
      });
      const blob = await c.convertToBlob({ type: m.format, quality: 0.9 });
      pages.push({ bytes: new Uint8Array(await blob.arrayBuffer()), width: PAGE.w, height: PAGE.h });
      const img = document.createElement('img');
      img.alt = `Contact sheet page ${pg + 1}`; img.width = 310; img.height = Math.round(310 * PAGE.h / PAGE.w);
      img.src = URL.createObjectURL(blob);
      const fig = document.createElement('figure'); fig.className = 'tile';
      const cap = document.createElement('figcaption'); cap.textContent = `Page ${pg + 1} of ${n}`;
      const box = document.createElement('div'); box.className = 'pic'; box.appendChild(img);
      fig.appendChild(box); fig.appendChild(cap); $('pages').appendChild(fig);
    }
    $('sum').textContent = `${sheet.tiles.length} photos on ${n} page${n === 1 ? '' : 's'}`;
    return pages;
  }

  // ---------- privacy ----------
  let onlyFlagged = true;
  function renderPrivacy(d) {
    $('title').textContent = d.title;
    $('actions').innerHTML = '<button class="tb" data-id="strip" title="Changes the files: GPS, serial numbers and owner names are removed, the image data stays as it is">Remove in place</button> <button class="tb" data-id="copies">Write cleaned copies</button> <button class="tb" data-id="csv">Save CSV</button>';
    const t = d.totals;
    const rows = d.rows.filter((r) => !onlyFlagged || r.found > 0 || r.error);
    $('app').innerHTML = `${d.note ? `<p class="ok">${esc(d.note)}</p>` : ''}<p><strong>${t.flagged}</strong> of ${t.files} photos hold private data: ${t.gps} with a GPS position, ${t.serial} with a serial number, ${t.owner} with an owner name or unique ID${t.unreadable ? `, ${t.unreadable} unreadable` : ''}.</p>
<p><label><input type="checkbox" id="only"${onlyFlagged ? ' checked' : ''}> Only photos with findings</label></p>
${rows.length ? `<table class="grid"><thead><tr><th>Photo</th><th>GPS position</th><th>Serial numbers</th><th>Owner or ID</th><th>Camera</th><th>Taken</th></tr></thead><tbody>${rows.map((r) => `<tr${r.found ? ' class="flag"' : ''}><td>${esc(r.path)}</td><td>${esc(r.gps)}</td><td>${esc(r.serial)}</td><td>${esc(r.owner)}</td><td>${esc(r.camera)}</td><td>${esc(r.error ? `cannot be read: ${r.error}` : r.taken)}</td></tr>`).join('')}</tbody></table>` : '<p class="ok">No photo holds a GPS position, a serial number or an owner name.</p>'}`;
    $('only').onchange = () => { onlyFlagged = $('only').checked; renderPrivacy(d); };
  }

  document.addEventListener('click', (e) => {
    const b = e.target && e.target.closest && e.target.closest('button[data-id]');
    if (b) vscode.postMessage({ type: 'action', id: b.getAttribute('data-id') });
  });

  window.addEventListener('message', async (e) => {
    const m = e.data;
    if (!m || typeof m !== 'object') return;
    try {
      if (m.type === 'mode') { kind = m.kind; if (kind === 'convert') renderConvert(m.title, m.total); }
      else if (m.type === 'encode') { const r = await encode(m); reply(m.id, r); }
      else if (m.type === 'row') addRow(m.row);
      else if (m.type === 'done') { const t = $('doneText'); if (t) t.textContent = m.text; }
      else if (m.type === 'sheetStart') { startSheet(m); reply(m.id, {}); }
      else if (m.type === 'tile') { await addTile(m); reply(m.id, {}); }
      else if (m.type === 'render') { const pages = await renderSheet(m); reply(m.id, { pages }); }
      else if (m.type === 'data') { kind = 'privacy'; renderPrivacy(m.data); requestAnimationFrame(() => vscode.postMessage({ type: 'shown' })); }
    } catch (err) {
      if (m.id) reply(m.id, { error: String((err && err.message) || err) });
    }
  });
  vscode.postMessage({ type: 'ready' });
})();
