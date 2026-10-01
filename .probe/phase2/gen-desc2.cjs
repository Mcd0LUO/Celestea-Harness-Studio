const fs = require('fs');
const t = JSON.parse(fs.readFileSync('contracts/tools.json', 'utf8'));
const names = { compress: 'COMPRESS_DESCRIPTION', decompress: 'DECOMPRESS_DESCRIPTION', context_status: 'CONTEXT_STATUS_DESCRIPTION' };
const out = [];
for (const name of Object.keys(names)) {
  const d = t.tools.find((x) => x.name === name).description;
  const sents = d.split(/(?<=\.)\s+/);
  const chunks = [];
  let cur = '';
  for (const s of sents) {
    if (cur === '') { cur = s; continue; }
    if ((cur + ' ' + s).length > 92) { chunks.push(cur); cur = s; } else { cur = cur + ' ' + s; }
  }
  if (cur !== '') chunks.push(cur);
  out.push('export const ' + names[name] + ' =');
  for (let i = 0; i < chunks.length; i += 1) {
    out.push('  ' + JSON.stringify(chunks[i]) + (i < chunks.length - 1 ? ' +' : ';'));
  }
  out.push('');
}
fs.writeFileSync('.probe/phase2/descriptions.ts', out.join(String.fromCharCode(10)) + String.fromCharCode(10), 'utf8');
console.log('ok');