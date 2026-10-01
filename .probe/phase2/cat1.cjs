const fs = require('fs');
const out = [];
const push = (f) => out.push(fs.readFileSync(f, 'utf8'));
push('.probe/phase2/tool-head.ts');
push('.probe/phase2/descriptions.ts');
fs.writeFileSync('.probe/phase2/tool-specs.ts', out.join(String.fromCharCode(10)), 'utf8');
console.log('ok');