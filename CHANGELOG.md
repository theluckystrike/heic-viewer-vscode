# Changelog

## 0.1.0

- First release. Opens .heic, .heif, .hif and .avif images in a VS Code editor tab, offline.
- HEIC decoding with libheif in a worker thread, so large photos never block the editor. AVIF uses the editor's own decoder.
- Grids, rotation and mirroring, crop, alpha, Display P3 color, 10-bit files, bursts and other multi-image files with an image picker.
- Info panel: size, codec, bit depth, chroma, color profile, thumbnails, camera, lens, exposure, date and the GPS position as numbers. XMP is read when a photo has no EXIF.
- Zovo Pro tools: Convert to JPEG, PNG or WebP; Contact sheet; Privacy check (3 free tries each).
