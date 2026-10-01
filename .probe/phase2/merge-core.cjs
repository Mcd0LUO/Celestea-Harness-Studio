const fs = require('fs');
const target = 'packages/core/src/compression.ts';
let text = fs.readFileSync(target, 'utf8');
const add = fs.readFileSync('.probe/phase2/block-thresholds.ts', 'utf8')
  + fs.readFileSync('.probe/phase2/block-philosophy.ts', 'utf8');
const anchor = '/**\n * The context budget facts, in the shape the statusline already froze.';
if (!text.includes(anchor)) throw new Error('anchor not found');
if (text.includes('COMPRESSION_PHILOSOPHY')) throw new Error('already merged');
text = text.replace(anchor, add + anchor);
fs.writeFileSync(target, text, 'utf8');
console.log('merged; file now', text.length, 'chars');