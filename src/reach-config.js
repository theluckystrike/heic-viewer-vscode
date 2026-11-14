'use strict';
// REACH1: this listing's Pro tools for the viewer toolbar row and the Explorer entries (src/reach.js).
module.exports = {
  prefix: 'heicViewer',
  triesKey: 'heicViewer.proTrial',
  slot: '#toolbar',
  tools: [
    { id: 'convert', title: 'Convert to JPEG, PNG or WebP', command: 'heicViewer.convert' },
    { id: 'sheet', title: 'Contact sheet', command: 'heicViewer.sheet' },
    { id: 'privacy', title: 'Privacy check', command: 'heicViewer.privacy' },
  ],
};
