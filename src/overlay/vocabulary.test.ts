/**
 * The on-screen vocabulary rule: the overlay never says "banked" or "spent", never an
 * onomatopoeia, never a size word (nice/big/huge). This test reads every non-test module under src/overlay and fails on
 * any string literal that does. Identifiers (`bankedTotal`, `bigIntensity`), object keys (`big:`), comments and regex
 * literals are not on screen and are not checked.
 */
import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

export const BANNED = /\b(banked|spent|bam|pow|boom|wham|kapow|nice|big|huge)\b/i;

/** Every `.ts` under `dir` (recursively) that is not a test. */
function modules(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...modules(full));
    else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) out.push(full);
  }
  return out.sort();
}

const REGEX_AFTER_PUNCT = /[(,=:[!&|?{};+\-*%<>~^]/;
const REGEX_AFTER_WORD = new Set(["return", "typeof", "case", "in", "of", "delete", "void", "throw", "new", "do", "else", "yield", "await"]);

/** A quoted string starting at `i` (which holds the quote); returns its raw text and the index after the closing quote. */
function quoted(src: string, i: number, quote: string): [string, number] {
  let j = i + 1;
  while (j < src.length && src[j] !== quote) j += src[j] === "\\" ? 2 : 1;
  return [src.slice(i + 1, j), j + 1];
}

/** A template literal starting at `i` (the backtick): its text segments go to `out`; returns the index after the closing backtick. */
function template(src: string, i: number, out: string[]): number {
  let j = i + 1;
  let segment = "";
  while (j < src.length) {
    const c = src[j]!;
    if (c === "\\") {
      segment += src.slice(j, j + 2);
      j += 2;
    } else if (c === "`") {
      out.push(segment);
      return j + 1;
    } else if (c === "$" && src[j + 1] === "{") {
      out.push(segment);
      segment = "";
      j = expression(src, j + 2, out);
    } else {
      segment += c;
      j++;
    }
  }
  out.push(segment);
  return j;
}

/** Skip a `${ … }` hole (nested strings and templates inside it are still collected); returns the index after `}`. */
function expression(src: string, i: number, out: string[]): number {
  let depth = 1;
  let j = i;
  while (j < src.length && depth > 0) {
    const c = src[j]!;
    if (c === '"' || c === "'") {
      const [text, end] = quoted(src, j, c);
      out.push(text);
      j = end;
    } else if (c === "`") j = template(src, j, out);
    else {
      if (c === "{") depth++;
      else if (c === "}") depth--;
      j++;
    }
  }
  return j;
}

/** String literals in a TypeScript source: "…", '…' and the text parts of `…`; comments and regex literals skipped. */
export function stringLiterals(src: string): string[] {
  const out: string[] = [];
  let i = 0;
  let prev = ""; // last significant character, for the regex-vs-division call
  let word = ""; // the identifier that ended at `prev`, if any
  while (i < src.length) {
    const c = src[i]!;
    const next = src[i + 1];
    if (c === "/" && next === "/") {
      const nl = src.indexOf("\n", i);
      i = nl < 0 ? src.length : nl;
      continue;
    }
    if (c === "/" && next === "*") {
      const end = src.indexOf("*/", i + 2);
      i = end < 0 ? src.length : end + 2;
      continue;
    }
    if (c === '"' || c === "'") {
      const [text, end] = quoted(src, i, c);
      out.push(text);
      i = end;
      prev = c;
      word = "";
      continue;
    }
    if (c === "`") {
      i = template(src, i, out);
      prev = c;
      word = "";
      continue;
    }
    if (c === "/" && (prev === "" || REGEX_AFTER_PUNCT.test(prev) || REGEX_AFTER_WORD.has(word))) {
      let inClass = false;
      i++;
      while (i < src.length) {
        const d = src[i]!;
        if (d === "\\") i += 2;
        else if (d === "[") (inClass = true), i++;
        else if (d === "]") (inClass = false), i++;
        else if (d === "/" && !inClass) break;
        else i++;
      }
      i++;
      while (/[a-z]/.test(src[i] ?? "")) i++; // flags
      prev = "/";
      word = "";
      continue;
    }
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (/[A-Za-z0-9_$]/.test(c)) word = /[A-Za-z0-9_$]/.test(prev) ? word + c : c;
    else word = "";
    prev = c;
    i++;
  }
  return out;
}

test("no overlay module puts banked / spent / an onomatopoeia / a size word in a string literal", () => {
  const files = modules(import.meta.dir);
  expect(files.map((f) => path.basename(f))).toEqual(expect.arrayContaining(["celebration.ts", "copy.ts", "state.ts", "theme.ts"])); // the sweep found the modules
  const hits: string[] = [];
  for (const file of files) {
    for (const literal of stringLiterals(readFileSync(file, "utf8"))) {
      if (BANNED.test(literal)) hits.push(`${path.relative(process.cwd(), file)}: ${JSON.stringify(literal)}`);
    }
  }
  expect(hits).toEqual([]);
});

test("the check catches a bad literal, and ignores identifiers, comments and regex literals", () => {
  const fixture = [
    "// banked is fine in a line comment",
    "/* +1 BANKED in a block comment */",
    "const total = state.bankedTotal + unlocksBanked; // identifiers only",
    "const re = /\\bspent\\b/i; const half = a / b; const q = x ? /pow/ : 0;",
    "function f() { return /boom/.test(s); }",
    "const label = `+${n} BANKED`;",
    'const done = "SPENT";',
    "const ok = 'READY TO DROP';",
    'const nested = `outer ${cond ? "wham" : `inner ${"kapow"}`}`;',
    'const escaped = "say \\"pow\\" here";',
    'const stinger = { big: "TIER 1 OPEN", sub: `${n} HUGE` }; // the key `big:` is not on screen; the value is',
  ].join("\n");
  const literals = stringLiterals(fixture);
  expect(literals).toEqual(["+", " BANKED", "SPENT", "READY TO DROP", "outer ", "wham", "inner ", "kapow", "", "", 'say \\"pow\\" here', "TIER 1 OPEN", "", " HUGE"]);
  expect(literals.filter((l) => BANNED.test(l))).toEqual([" BANKED", "SPENT", "wham", "kapow", 'say \\"pow\\" here', " HUGE"]);
  expect(BANNED.test("Kapow!")).toBe(true);
  expect(BANNED.test("+1 UNLOCK · READY TO DROP")).toBe(false);
  expect(BANNED.test("DONE")).toBe(false);
  expect(BANNED.test("bankedTotal")).toBe(false); // a word on screen, not a substring of an identifier
  for (const size of ["nice", "BIG", "Huge"]) expect(BANNED.test(`a ${size} tip`)).toBe(true); // no size words either
  expect(BANNED.test("bigIntensity")).toBe(false);
  expect(BANNED.test("TIER 1 OPEN")).toBe(false);
});
