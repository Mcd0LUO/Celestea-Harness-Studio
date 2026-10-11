/**
 * Duplicate-key detection for `mcp.json`.
 *
 * `JSON.parse` keeps the LAST of two identical keys and says nothing, which is
 * exactly the failure docs/feature/mcp-client.md §4.1 forbids: "a same-scope
 * duplicate server name is a startup error, not 'the later one wins'". An operator
 * who pasted a server block twice would otherwise get one server carrying the
 * second block's settings and no warning.
 *
 * We therefore walk the RAW TEXT instead of the parsed value. This is a scanner,
 * not a validator: the parsed object still goes through `JSON.parse` (and the
 * per-entry validation in config.ts); the only thing extracted here is the key
 * path of every repeated key.
 *
 * Malformed JSON is NOT this file's business — it bails out and lets
 * `JSON.parse` produce the one authoritative error.
 */

/** One repeated key, as a dotted path (`servers.memory`). */
export interface DuplicateKey {
  readonly path: string;
  readonly key: string;
}

class KeyScanner {
  private pos = 0;
  private readonly duplicates: DuplicateKey[] = [];

  constructor(private readonly text: string) {}

  scan(): DuplicateKey[] {
    this.value([]);
    return this.duplicates;
  }

  private skipSpace(): void {
    while (this.pos < this.text.length && (this.text[this.pos] ?? "").trim() === "") this.pos++;
  }

  private peek(): string {
    this.skipSpace();
    return this.text[this.pos] ?? "";
  }

  private value(path: string[]): void {
    const ch = this.peek();
    if (ch === "{") return this.object(path);
    if (ch === "[") return this.array(path);
    if (ch === '"') {
      this.stringToken();
      return;
    }
    this.literalToken();
  }

  private object(path: string[]): void {
    this.pos++; // '{'
    const seen = new Set<string>();
    for (;;) {
      if (this.peek() !== '"') return; // end of input or malformed: JSON.parse owns it
      const key = this.stringToken();
      if (seen.has(key)) this.duplicates.push({ path: [...path, key].join("."), key });
      seen.add(key);
      this.skipSpace();
      if (this.peek() === ":") this.pos++;
      this.value([...path, key]);
      const next = this.peek();
      if (next === ",") {
        this.pos++;
        continue;
      }
      if (next === "}") this.pos++;
      return;
    }
  }

  private array(path: string[]): void {
    this.pos++; // '['
    let index = 0;
    for (;;) {
      const ch = this.peek();
      if (ch === "]" || ch === "") {
        if (ch === "]") this.pos++;
        return;
      }
      this.value([...path, String(index)]);
      index++;
      const next = this.peek();
      if (next === ",") {
        this.pos++;
        continue;
      }
      if (next === "]") this.pos++;
      return;
    }
  }

  /** Consume one JSON string token (escapes included) and return its value. */
  private stringToken(): string {
    const start = this.pos;
    this.pos++;
    while (this.pos < this.text.length) {
      const ch = this.text[this.pos];
      if (ch === "\\") {
        this.pos += 2;
        continue;
      }
      this.pos++;
      if (ch === '"') break;
    }
    const raw = this.text.slice(start, this.pos);
    try {
      return String(JSON.parse(raw));
    } catch {
      return raw;
    }
  }

  /** Consume a number / true / false / null up to the next structural character. */
  private literalToken(): void {
    while (this.pos < this.text.length && !",}] \n\t\r".includes(this.text[this.pos] ?? "x")) this.pos++;
  }
}

/** Every repeated key in a JSON text, in document order. */
export function findDuplicateKeys(text: string): DuplicateKey[] {
  return new KeyScanner(text).scan();
}
