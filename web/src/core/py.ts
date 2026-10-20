/**
 * Small ports of the Python standard library behaviour the checker relies on, so that
 * the TypeScript port reads labels and writes reports exactly like the Python tool.
 *
 * Regex classes: Python's `\w`, `\d` and `\s` are Unicode-aware on str patterns, while
 * JavaScript's are ASCII-only (`\w`, `\d`) or a different set (`\s`). The constants below
 * spell out Python's sets for use in `u`-flag patterns.
 */

import { HTML5, INVALID_CHARREFS, INVALID_CODEPOINTS } from "./html-entities.js";

/** Python `\w` on str: letters, numbers and the underscore. */
export const W = "[\\p{L}\\p{N}_]";
/** Inside a character class: the members of `W`. */
export const W_MEMBERS = "\\p{L}\\p{N}_";
/** Python `\d` on str: decimal digits of any script. */
export const D = "\\p{Nd}";
/** The characters Python's str.isspace() accepts, which is also what `\s` and strip() use. */
export const WS_MEMBERS = "\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
/** Python `\s` on str. */
export const S = `[${WS_MEMBERS}]`;
/** Python `\b` (word boundary) next to a word character on the left or right. */
export const B_BEFORE = `(?<!${W})`;
export const B_AFTER = `(?!${W})`;

const WS_SET = new RegExp(`^${S}$`, "u");

function stripSet(chars: string | undefined): (c: string) => boolean {
  if (chars === undefined) return (c) => WS_SET.test(c);
  return (c) => chars.includes(c);
}

/** str.strip(chars) */
export function strip(text: string, chars?: string): string {
  return rstrip(lstrip(text, chars), chars);
}

/** str.lstrip(chars) */
export function lstrip(text: string, chars?: string): string {
  const inSet = stripSet(chars);
  const cps = Array.from(text);
  let i = 0;
  while (i < cps.length && inSet(cps[i]!)) i++;
  return cps.slice(i).join("");
}

/** str.rstrip(chars) */
export function rstrip(text: string, chars?: string): string {
  const inSet = stripSet(chars);
  const cps = Array.from(text);
  let j = cps.length;
  while (j > 0 && inSet(cps[j - 1]!)) j--;
  return cps.slice(0, j).join("");
}

/** str.splitlines() */
export function splitlines(text: string): string[] {
  const parts = text.split(/\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]/u);
  if (parts[parts.length - 1] === "") parts.pop();
  return parts;
}

/** len() of a str: the number of code points. */
export function len(text: string): number {
  let n = 0;
  for (const _ of text) n++;
  return n;
}

// ---- html.unescape ----------------------------------------------------------------------

const CHARREF_RE = /&(#[0-9]+;?|#[xX][0-9a-fA-F]+;?|[^\t\n\f <&#;]{1,32};?)/gu;

function replaceCharref(s: string): string {
  if (s[0] === "#") {
    const num = s[1] === "x" || s[1] === "X"
      ? parseInt(rstrip(s.slice(2), ";"), 16)
      : parseInt(rstrip(s.slice(1), ";"), 10);
    if (num in INVALID_CHARREFS) return INVALID_CHARREFS[num]!;
    if ((num >= 0xd800 && num <= 0xdfff) || num > 0x10ffff) return "�";
    if (INVALID_CODEPOINTS.has(num)) return "";
    return String.fromCodePoint(num);
  }
  if (Object.hasOwn(HTML5, s)) return HTML5[s]!;
  // The longest matching name, as defined by the standard.
  const cps = Array.from(s);
  for (let x = cps.length - 1; x > 1; x--) {
    const head = cps.slice(0, x).join("");
    if (Object.hasOwn(HTML5, head)) return HTML5[head]! + cps.slice(x).join("");
  }
  return "&" + s;
}

/** html.unescape() */
export function htmlUnescape(text: string): string {
  if (!text.includes("&")) return text;
  return text.replace(CHARREF_RE, (_m, ref: string) => replaceCharref(ref));
}

// ---- difflib.SequenceMatcher(None, a, b).ratio() ----------------------------------------

/** difflib.SequenceMatcher(None, a, b).ratio() with the default autojunk=True. */
export function sequenceRatio(aText: string, bText: string): number {
  const a = Array.from(aText);
  const b = Array.from(bText);
  const total = a.length + b.length;
  if (total === 0) return 1.0;

  // b2j with the "popular element" heuristic for long sequences.
  const b2j = new Map<string, number[]>();
  b.forEach((elt, i) => {
    const indices = b2j.get(elt);
    if (indices) indices.push(i);
    else b2j.set(elt, [i]);
  });
  const n = b.length;
  if (n >= 200) {
    const ntest = Math.floor(n / 100) + 1;
    for (const [elt, idxs] of [...b2j]) {
      if (idxs.length > ntest) b2j.delete(elt);
    }
  }

  const findLongestMatch = (alo: number, ahi: number, blo: number, bhi: number): [number, number, number] => {
    let besti = alo;
    let bestj = blo;
    let bestsize = 0;
    let j2len = new Map<number, number>();
    for (let i = alo; i < ahi; i++) {
      const newj2len = new Map<number, number>();
      for (const j of b2j.get(a[i]!) ?? []) {
        if (j < blo) continue;
        if (j >= bhi) break;
        const k = (j2len.get(j - 1) ?? 0) + 1;
        newj2len.set(j, k);
        if (k > bestsize) {
          besti = i - k + 1;
          bestj = j - k + 1;
          bestsize = k;
        }
      }
      j2len = newj2len;
    }
    // Extend the match with equal elements on both sides. Popular elements are not junk
    // (difflib's bjunk is empty without isjunk), so they may be used here.
    while (besti > alo && bestj > blo && a[besti - 1] === b[bestj - 1]) {
      besti--; bestj--; bestsize++;
    }
    while (besti + bestsize < ahi && bestj + bestsize < bhi && a[besti + bestsize] === b[bestj + bestsize]) {
      bestsize++;
    }
    return [besti, bestj, bestsize];
  };

  let matches = 0;
  const queue: [number, number, number, number][] = [[0, a.length, 0, b.length]];
  while (queue.length) {
    const [alo, ahi, blo, bhi] = queue.pop()!;
    const [i, j, k] = findLongestMatch(alo, ahi, blo, bhi);
    if (k) {
      matches += k;
      if (alo < i && blo < j) queue.push([alo, i, blo, j]);
      if (i + k < ahi && j + k < bhi) queue.push([i + k, ahi, j + k, bhi]);
    }
  }
  return (2.0 * matches) / total;
}

// ---- textwrap.fill -----------------------------------------------------------------------

const TW_WS = "\\t\\n\\x0b\\x0c\\r ";
const TW_WP = `[${W_MEMBERS}!"'&.,?]`;
const TW_LT = `[\\p{L}\\p{Nl}\\p{No}_]`; // Python [^\d\W]
const WORDSEP_RE = new RegExp(
  `([${TW_WS}]+` +
  `|(?<=${TW_WP})-{2,}(?=${W})` +
  `|[^${TW_WS}]+?(?:` +
    `-(?:(?<=${TW_LT}{2}-)|(?<=${TW_LT}-${TW_LT}-))(?=${TW_LT}-?${TW_LT})` +
    `|(?=[${TW_WS}]|$)` +
    `|(?<=${TW_WP})(?=-{2,}${W})` +
  `))`,
  "u",
);

function expandTabs(text: string, tabsize = 8): string {
  let out = "";
  let column = 0;
  for (const c of text) {
    if (c === "\t") {
      const spaces = tabsize - (column % tabsize);
      out += " ".repeat(spaces);
      column += spaces;
    } else {
      out += c;
      column = c === "\n" || c === "\r" ? 0 : column + 1;
    }
  }
  return out;
}

/** textwrap.fill(text, width, initial_indent=..., subsequent_indent=...) with the other
 * options at their defaults. */
export function textwrapFill(text: string, width: number, initialIndent: string, subsequentIndent: string): string {
  const munged = expandTabs(text).replace(/[\t\n\x0b\x0c\r]/g, " ");
  const chunks = munged.split(WORDSEP_RE).filter((c) => c);
  chunks.reverse();
  const isSpace = (c: string) => strip(c) === "";
  const lines: string[] = [];
  while (chunks.length) {
    const curLine: string[] = [];
    let curLen = 0;
    const indent = lines.length ? subsequentIndent : initialIndent;
    const w = width - len(indent);
    if (isSpace(chunks[chunks.length - 1]!) && lines.length) chunks.pop();
    while (chunks.length) {
      const l = len(chunks[chunks.length - 1]!);
      if (curLen + l <= w) {
        curLine.push(chunks.pop()!);
        curLen += l;
      } else {
        break;
      }
    }
    if (chunks.length && len(chunks[chunks.length - 1]!) > w) {
      // _handle_long_word with break_long_words and break_on_hyphens
      const spaceLeft = w < 1 ? 1 : w - curLen;
      const chunk = Array.from(chunks[chunks.length - 1]!);
      let end = spaceLeft;
      if (chunk.length > spaceLeft) {
        const hyphen = chunk.slice(0, spaceLeft).lastIndexOf("-");
        if (hyphen > 0 && chunk.slice(0, hyphen).some((c) => c !== "-")) end = hyphen + 1;
      }
      curLine.push(chunk.slice(0, end).join(""));
      chunks[chunks.length - 1] = chunk.slice(end).join("");
      curLen = curLine.reduce((sum, c) => sum + len(c), 0);
    }
    if (curLine.length && isSpace(curLine[curLine.length - 1]!)) {
      curLen -= len(curLine[curLine.length - 1]!);
      curLine.pop();
    }
    if (curLine.length) lines.push(indent + curLine.join(""));
  }
  return lines.join("\n");
}
