# Third-party notices

## libheif and libde265 (LGPL-3.0)

`lib/libheif/libheif.js` and `lib/libheif/libheif.wasm` are the unmodified WebAssembly build of libheif 1.23.5 from the npm package `libheif-js` 1.23.5 (https://github.com/catdad-experiments/libheif-js). The build contains libheif (https://github.com/strukturag/libheif) and the libde265 HEVC decoder (https://github.com/strukturag/libde265). Both libraries are licensed under the GNU Lesser General Public License version 3 (LGPL-3.0). The full licence texts are in `lib/libheif/LICENSE-libheif.txt` and `lib/libheif/LICENSE-libheif-js.txt`.

The extension loads these two files at run time from the `lib/libheif` folder; they are not compiled into the extension's own code. You may replace them with your own build of the same libheif-js version. The source code of this exact version is published at the links above (tag v1.23.5 of libheif-js, which names the libheif and libde265 versions it builds).

SHA-256 of the shipped files:

- libheif.js: 376c0bb483c23ac458cd22d718074693748ea75eddc3e4929353d4153e365a2e
- libheif.wasm: 184d3d20f8323877f13e9f5254f9c6a0ce272c9a3a2f823b0b2bcd2ee9f73f80

## Sample photos

`samples/sample-wind-farm.heic` and `samples/sample-wind-farm.avif` are a resized copy of `3B_HEIC_SDR.heic` from https://github.com/aaron-rust/hdr-sample-images, released under CC0 1.0 (public domain). The GPS position and the camera serial number in their EXIF are made up for the privacy demo.

## Everything else

`src/core/png.js` and every other source file are written for this extension (MIT, see LICENSE). No other third-party code is included.
