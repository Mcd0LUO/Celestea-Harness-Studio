/**
 * json-dup-keys.mjs — 找出 JSON 里的**重复键**。
 *
 * 为什么需要它：JSON.parse 对重复键**不报错、取最后一条**。于是
 *
 *   { "note36": "甲", "note36": "乙" }
 *
 * 得到乙，而甲**被完全遮蔽** —— 没有类型错误、没有 lint 规则、没有任何门禁会红。
 * 它是纯静默的数据丢失，而且写这两条键的人**都以为自己的内容在文件里**。
 *
 * 2026-10-04 实测：apps/web/tools/bundle-size-baseline.json 里同时有两条 note36
 * （W9103 的与 W9329 新加的）与两条 note35（W1545+W1546 的与 W9327 写进去的）。
 * 那是 W9329 手工发现的 —— 当时没有任何门禁察觉。
 *
 * 自己走一遍词法：JSON.parse 拿不到重复键（它已经把后者覆盖掉了）。只做**结构遍历**，
 * 不构造值，所以再大的文件也只是 O(n)。
 */

/**
 * @param {string} text 合法 JSON 文本
 * @returns {{ path: string, key: string, first: number, again: number }[]}
 */
export function scanDuplicateKeys(text) {
  let i = 0;
  const problems = [];
  const path = [];
  const ws = () => { while (i < text.length && /\s/.test(text[i])) i += 1; };
  const readString = () => {
    const start = i;
    i += 1;
    while (i < text.length) {
      const c = text[i];
      if (c === "\\") { i += 2; continue; }
      if (c === '"') { i += 1; return JSON.parse(text.slice(start, i)); }
      i += 1;
    }
    throw new Error("unterminated string at " + start);
  };
  const where = (key) => (path.length === 0 ? key : path.join(".") + "." + key);
  const value = () => {
    ws();
    const c = text[i];
    if (c === "{") return object();
    if (c === "[") return array();
    if (c === '"') { readString(); return undefined; }
    while (i < text.length && !/[,\]}\s]/.test(text[i])) i += 1;
    return undefined;
  };
  const object = () => {
    i += 1;
    ws();
    const seen = new Map();
    if (text[i] === "}") { i += 1; return undefined; }
    for (;;) {
      ws();
      const at = i;
      const key = readString();
      if (seen.has(key)) problems.push({ path: where(key), key, first: seen.get(key), again: at });
      else seen.set(key, at);
      ws();
      if (text[i] !== ":") throw new Error("expected ':' at " + i);
      i += 1;
      path.push(key);
      value();
      path.pop();
      ws();
      if (text[i] === ",") { i += 1; continue; }
      if (text[i] === "}") { i += 1; return undefined; }
      throw new Error("expected ',' or '}' at " + i);
    }
  };
  const array = () => {
    i += 1;
    ws();
    if (text[i] === "]") { i += 1; return undefined; }
    for (let n = 0; ; n += 1) {
      path.push("[" + n + "]");
      value();
      path.pop();
      ws();
      if (text[i] === ",") { i += 1; continue; }
      if (text[i] === "]") { i += 1; return undefined; }
      throw new Error("expected ',' or ']' at " + i);
    }
  };
  value();
  ws();
  if (i !== text.length) throw new Error("trailing data at " + i);
  return problems;
}
