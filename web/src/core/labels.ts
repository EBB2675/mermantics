/** Reading ontology IDs and the text written around them in diagram labels. */

import { OBO_BASE } from "./model.js";
import { B_AFTER, B_BEFORE, D, S, W_MEMBERS, htmlUnescape, rstrip, strip } from "./py.js";

// Matches OBO-style IDs such as PMD_0000933 or IAO_0000030. The prefix must start with
// an upper-case letter and the number must have 5 to 9 digits, so names like
// MAT_SIM_STRUCTURE or job_id are not picked up.
const CURIE_SOURCE = `${B_BEFORE}([A-Z][A-Za-z]*)_(${D}{5,9})${B_AFTER}`;
export const CURIE_RE = new RegExp(CURIE_SOURCE, "u");
const CURIE_RE_G = new RegExp(CURIE_SOURCE, "gu");

const BR_RE = new RegExp(`<br${S}*/?>`, "giu");
const TAG_RE = /<[^>]+>/gu;
// Mermaid's own entity codes, e.g. #quot; or #35;
const MERMAID_ENTITY_RE = new RegExp(`#([${W_MEMBERS}]+);`, "gu");
const MERMAID_NAMED: Record<string, string> = { quot: '"', amp: "&", lt: "<", gt: ">", nbsp: " " };

// A written label may continue after the ontology label with one of these, e.g.
// "is about, optional" still counts as "is about".
const LABEL_CONTINUATION = ",;(:";

function mermaidEntity(match: string, code: string): string {
  if (/^[0-9]+$/.test(code)) return String.fromCodePoint(parseInt(code, 10));
  return Object.hasOwn(MERMAID_NAMED, code) ? MERMAID_NAMED[code]! : match;
}

/** Split a label into lines at <br>, strip other HTML tags and unescape entities. */
export function segments(raw: string): string[] {
  let text = raw.replace(MERMAID_ENTITY_RE, mermaidEntity);
  text = text.replace(BR_RE, "\n");
  text = text.replace(TAG_RE, "");
  text = htmlUnescape(text);
  return text.split("\n").map((part) => strip(part));
}

/** Label as one line of plain text. */
export function plain(raw: string): string {
  return segments(raw).filter((s) => s).join(" ");
}

/** First non-empty line of a label (usually the bold class name). */
export function title(raw: string, fallback: string): string {
  for (const seg of segments(raw)) {
    if (seg) return seg;
  }
  return fallback;
}

/** All ontology IDs in a label, in order, without duplicates. */
export function findCuries(raw: string): string[] {
  const seen: string[] = [];
  for (const seg of segments(raw)) {
    for (const m of seg.matchAll(CURIE_RE_G)) {
      if (!seen.includes(m[0])) seen.push(m[0]);
    }
  }
  return seen;
}

export function curieToIri(curie: string, prefixes: Record<string, string>): string {
  const cut = curie.indexOf("_");
  const prefix = curie.slice(0, cut);
  const number = curie.slice(cut + 1);
  if (Object.hasOwn(prefixes, prefix)) return prefixes[prefix]! + number;
  return `${OBO_BASE}${prefix}_${number}`;
}

/** Python's `text.split(sep, 1)` for a separator known to be in the text. */
function splitOnce(text: string, sep: string): [string, string] {
  const i = text.indexOf(sep);
  return [text.slice(0, i), text.slice(i + sep.length)];
}

/**
 * Text written next to an ID, as [same line, neighbouring lines].
 *
 * Same line: the text after and before the ID on its own line. Text before the ID
 * that ends with a colon ("MC:", "Local subclass of:") is a code or heading, not a
 * label, and is left out.
 * Neighbouring lines: the nearest non-empty line before and after it.
 */
export function textNear(raw: string, curie: string): [string[], string[]] {
  const segs = segments(raw);
  const same: string[] = [];
  const near: string[] = [];
  segs.forEach((seg, i) => {
    if (!seg.includes(curie)) return;
    const [before, after] = splitOnce(seg, curie);
    same.push(after);
    if (!rstrip(before).endsWith(":")) same.push(before);
    for (let j = i - 1; j >= 0; j--) {
      if (segs[j]) {
        near.push(segs[j]!);
        break;
      }
    }
    for (let j = i + 1; j < segs.length; j++) {
      if (segs[j]) {
        near.push(segs[j]!);
        break;
      }
    }
  });

  const clean = (items: string[]): string[] => {
    const out: string[] = [];
    for (let c of items) {
      c = strip(c);
      if (normalise(c) && !out.includes(c) && !CURIE_RE.test(c)) out.push(c);
    }
    return out;
  };

  return [clean(same), clean(near)];
}

const SPACE_RUN_RE = new RegExp(`[${S.slice(1, -1)}_]+`, "gu");

export function normalise(text: string): string {
  text = text.toLowerCase();
  text = text.replace(SPACE_RUN_RE, " ");
  return strip(text, " :;,.-");
}

/** True if any written text equals an ontology label (ignoring case and spacing),
 * or starts with it followed by , ; ( or : */
export function labelMatches(ontologyLabels: string[], candidates: string[]): boolean {
  for (const label of ontologyLabels) {
    const lab = normalise(label);
    if (!lab) continue;
    for (const cand of candidates) {
      const c = normalise(cand);
      if (c === lab) return true;
      if (c.startsWith(lab) && c.length > lab.length) {
        if (LABEL_CONTINUATION.includes(c[lab.length]!)) return true;
      }
    }
  }
  return false;
}
