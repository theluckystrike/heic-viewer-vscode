# HEIC Viewer & AVIF Viewer 0.1.0 (zovo.zovo-heic-viewer)

New listing, staged only. NICHE3 row 5, built by lane NEWB10.

- vsix: out/NEWB10-dist/zovo.zovo-heic-viewer/zovo.zovo-heic-viewer-0.1.0.vsix
- sha256: daf0ffd708461f0a1515a2f839734061f2800df065dcd30ee932b7a8847da10e
- Unit tests: 232 of 232 pass (Node test runner: container parser, EXIF, privacy cleaner, EXIF embedding, PDF, libheif worker, extension and Pro tools with the vscode stub, license, rating).
- Real-app gate: VS Code 1.142.0 on port 9401 through buildslot, run r4 on this exact vsix: 79 PASS, 0 FAIL (out/NEWB10-data/heic/heic-gate-r4.tsv, screenshots in out/NEWB10-data/heic/shots). Runs r1 to r3 found and fixed: the .avif default-editor clash with VS Code's image preview, a broken Explorer menu regex for .heic files, a quick pick that closed when focus went back to the webview after the Command Palette, and three wrong gate expectations.

## What it is

- Display name: HEIC Viewer & AVIF Viewer (25 characters). Search phrase "heic" comes first. The description starts with "HEIC viewer".
- Keywords: heic, heif, avif, image viewer, iphone photos. Engines: ^1.75.0, so it installs in Cursor and Windsurf.
- Free core: a custom editor for .heic, .heif and .hif (default) and .avif (optional editor, see limits). HEIC decoding runs in a worker thread with libheif 1.23.5 (LGPL-3.0, shipped unmodified as a separate WASM file). AVIF is decoded by the editor's own Chromium decoder. Zoom, pan, fit, 1:1, color under the cursor, background switch, an image picker for multi-image files, and an info panel: size, codec, grid, bit depth, chroma, color profile, alpha, depth, thumbnails, camera EXIF (XMP fallback), GPS as numbers, privacy findings, all EXIF tags.
- Zovo Pro tools (3 free tries each, module card2 + reach1 + proinfo, listing tag "heic"): Convert to JPEG, PNG or WebP (file or folder, quality, size, EXIF keep / keep without GPS and serials / remove, report); Contact sheet (A4 pages, PDF or PNG); Privacy check (GPS, serial numbers, owner and device names, unique IDs in EXIF and XMP; remove in place after a modal confirm, or write cleaned copies; CSV).
- No popups, toasts or nags on open. No network calls (webview CSP default-src 'none'; no fetch or socket code).

## Samples used

- Shipped: samples/sample-wind-farm.heic and .avif, 1600 x 1066, made with macOS sips from `3B_HEIC_SDR.heic` (CC0 1.0, aaron-rust/hdr-sample-images, via nokiatech/heif content/cc0). Their EXIF is ours: the real camera and lens of that photo, a made-up GPS position (52.3751389, 9.7367361) and a made-up serial number (SAMPLE-0001).
- Unit-test fixtures (not in the vsix): 64 x 48 test patterns written by sips (HEIC, HEIC with irot from EXIF orientation 6, AVIF, JPEG) and a HEIF container built box by box in the test.
- Real-app gate (not shipped): Nokia HEIF conformance and demo files (C003 two images, C014 derived images with rotation, alpha overlay, grid, bird burst, 45-megapixel 10-bit HEIC 3B_HEIC_SDR, VVC HEIF, an iPhone XS Max photo), libheif example.heic and example.avif, link-u AVIF samples (kimono, rotate90, mirror-horizontal, fox 10-bit), the AOM Chimera cropped AVIF, the 8256 x 5504 10-bit 4:4:4 grid AVIF IMAGE_019, a macOS wallpaper HEIC (6016 x 6016 grid, Display P3), and a JPEG renamed to .heic.

## Known limits

- VS Code's built-in image preview also opens .avif. To avoid VS Code asking which editor to use, the AVIF editor is registered as an option: users open .avif with right-click > Open in HEIC Viewer, or make it the default with Reopen Editor With. HEIC, HEIF and HIF open in this viewer by default.
- libheif in this build decodes HEVC only. HEIF files with VVC, AV1 inside a .heic name, JPEG 2000, uncompressed (unci) or gain-map (tmap) images open with their details and a plain note instead of pixels.
- 10-bit and HDR images are shown at 8 bits without tone mapping; PQ and HLG photos look flat in bright areas.
- AVIF shows the primary image only; animated AVIF shows its first frame. Image sequence tracks in HEIF (msf1) are not played; the still items are shown.
- Large photos: a 45-megapixel HEIC takes about 1.5 s to decode and the decoder worker uses up to about 800 MB while it runs; it ends 20 s after the last decode and gives the memory back. maxFileSizeMB (300) refuses bigger files.
- The privacy cleaner works inside the existing metadata bytes (same length), so it cannot clean EXIF or XMP that is split into several pieces; those files are listed as not cleanable. It does not touch maker notes. The device name (HostComputer tag) counts as private.
- Converted files: the encoder is the editor's own (OffscreenCanvas). JPEG output has no alpha (transparent parts become white). EXIF over 64 KB is not written into JPEG. ICC profiles are not copied into converted files.
- The contact sheet uses a fixed A4 layout at 150 dpi with system fonts. JPEG, PNG and WebP tiles show the file name without the date.
- 10-bit PQ HDR AVIF: the editor's decoder tone-maps it; colors differ from the macOS decoder (the gate checks size only for that file).
- The gate's palette-run and toolbar-run conversions passed; native folder dialogs (Choose a folder...) were not driven by the gate. Folder runs were tested from the Explorer right-click, which passes the folder directly.
