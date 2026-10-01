const fs = require("node:fs");
const src = process.argv[2];
const out = process.argv[3];
const text = fs.readFileSync(src, "utf8");
fs.writeFileSync(out, text, "utf8");
console.log("copied", text.length, "chars to", out);
