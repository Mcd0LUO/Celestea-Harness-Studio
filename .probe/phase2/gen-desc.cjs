const fs=require('fs');
const t=JSON.parse(fs.readFileSync('contracts/tools.json','utf8'));
const out=[];
for(const n of ['compress','decompress','context_status']){
  const d=t.tools.find(x=>x.name===n).description;
  // split into chunks on sentence boundaries, then wrap <=108 cols at spaces
  const sents=d.split(/(?<=\.)\s+/);
  const lines=[];let cur='';
  for(const s of sents){
    if(cur.length===0){cur='  '+s;continue;}
    if((cur+' '+s).length>108){lines.push(cur);cur='  '+s;}else{cur+=' '+s;}
  }
  if(cur)lines.push(cur);
  out.push('const NAME="'+n.toUpperCase()+'_DESCRIPTION"');
  out.push(lines.map((l,i)=>i===0?l:l).join('\n  + " "\n'));
  out.push('');
}
fs.writeFileSync('.probe/phase2/descriptions.txt',out.join('\n'),'utf8');
console.log('written', out.join('\n').length);
