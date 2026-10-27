/**
 * A search index over the terms of an ontology, for picking IDs in the form editor.
 *
 * Built once per loaded ontology. Each term has its IRI, the ID a diagram writes for it
 * (or null if the IRI cannot be written as an ID under the diagram conventions), its
 * labels, kind, deprecated flag and definition (IAO_0000115, or skos:definition, which
 * PMDco uses for most of its own terms).
 */

import { DataFactory, type Literal } from "n3";
import type { Term as RdfTerm } from "@rdfjs/types";

import * as labels from "./labels.js";
import { OBO_BASE } from "./model.js";
import { OWL, RDF, RDFS, SKOS, type Ontology } from "./ontology.js";

const { namedNode } = DataFactory;

const DEFINITIONS = [namedNode(`${OBO_BASE}IAO_0000115`), namedNode("http://www.w3.org/2004/02/skos/core#definition")];
const TYPES = [OWL.Class, RDFS.Class, OWL.ObjectProperty, OWL.DatatypeProperty, OWL.AnnotationProperty,
               OWL.NamedIndividual];

export interface Term {
  iri: string;
  id: string | null; // e.g. "PMD_0000933"; null if the IRI cannot be written as an ID
  label: string; // the label to write next to the ID
  labels: string[];
  kind: string; // as Ontology.kind: "class", "object property", ...
  deprecated: boolean;
  definition: string;
}

export interface SearchResult {
  terms: Term[];
  total: number; // matches before the limit
}

export interface SearchOptions {
  kinds?: string[]; // only these kinds
  limit?: number;
}

/** The ID for an IRI, if the diagram conventions turn that ID back into the same IRI. */
export function curieOf(iri: string, prefixes: Record<string, string>): string | null {
  let curie: string | null = null;
  for (const [prefix, base] of Object.entries(prefixes)) {
    if (iri.startsWith(base)) curie = `${prefix}_${iri.slice(base.length)}`;
  }
  if (curie === null && iri.startsWith(OBO_BASE)) curie = iri.slice(OBO_BASE.length);
  if (curie === null) return null;
  const found = labels.findCuries(curie);
  if (found.length !== 1 || found[0] !== curie) return null;
  return labels.curieToIri(curie, prefixes) === iri ? curie : null;
}

interface Entry {
  term: Term;
  names: string[]; // normalised labels
  words: string[][]; // words of each normalised label
  id: string; // lower case ID, or ""
}

const WORD_SPLIT_RE = /[^\p{L}\p{N}]+/u;

function words(text: string): string[] {
  return text.split(WORD_SPLIT_RE).filter((w) => w);
}

/** 0 exact, 1 starts with the query, 2 every query word starts a label word, 3 contains it. */
function labelRank(entry: Entry, query: string, queryWords: string[]): number | null {
  let best: number | null = null;
  entry.names.forEach((name, i) => {
    let rank: number | null = null;
    if (name === query) rank = 0;
    else if (name.startsWith(query)) rank = 1;
    else if (queryWords.length && queryWords.every((q) => entry.words[i]!.some((w) => w.startsWith(q)))) rank = 2;
    else if (name.includes(query)) rank = 3;
    if (rank !== null && (best === null || rank < best)) best = rank;
  });
  return best;
}

function idRank(entry: Entry, query: string): number | null {
  if (!entry.id) return null;
  if (entry.id === query) return 0;
  if (entry.id.startsWith(query)) return 1;
  // Only the number: "933" or "0000933"
  if (/^[0-9]+$/.test(query) && entry.id.slice(entry.id.indexOf("_") + 1).includes(query)) return 3;
  return null;
}

export class TermIndex {
  private readonly entries: Entry[] = [];
  private readonly byId = new Map<string, Term>();

  private constructor() {}

  static build(onto: Ontology, prefixes: Record<string, string>): TermIndex {
    const index = new TermIndex();
    const store = onto.store;
    const graph = onto.graph as never;
    const seen = new Set<string>();
    const candidates: RdfTerm[] = [];
    const add = (t: RdfTerm) => {
      if (t.termType === "NamedNode" && !seen.has(t.value)) {
        seen.add(t.value);
        candidates.push(t);
      }
    };
    for (const type of TYPES) for (const s of store.getSubjects(RDF.type, type, graph)) add(s);
    for (const p of [RDFS.label, SKOS.prefLabel]) for (const s of store.getSubjects(p, null, graph)) add(s);
    const headers = new Set(store.getSubjects(RDF.type, OWL.Ontology, graph).map((t) => t.value));

    for (const iri of candidates) {
      if (headers.has(iri.value)) continue;
      const names = onto.labels(iri);
      const definitions = DEFINITIONS.flatMap((p) => store.getObjects(iri, p, graph))
        .filter((d): d is Literal => d.termType === "Literal");
      const definition = definitions.find((d) => d.language === "" || d.language.startsWith("en")) ?? definitions[0];
      const term: Term = {
        iri: iri.value,
        id: curieOf(iri.value, prefixes),
        label: onto.label(iri),
        labels: names,
        kind: onto.kind(iri),
        deprecated: onto.deprecated(iri),
        definition: definition?.value ?? "",
      };
      const normalised = names.map((n) => labels.normalise(n)).filter((n) => n);
      index.entries.push({ term, names: normalised, words: normalised.map(words), id: term.id?.toLowerCase() ?? "" });
      if (term.id) index.byId.set(term.id, term);
    }
    return index;
  }

  get size(): number {
    return this.entries.length;
  }

  /** The term with this ID, if the ontology has it. */
  get(id: string): Term | undefined {
    return this.byId.get(id);
  }

  /**
   * Terms whose ID or labels match the query. Exact matches come first, then prefix
   * matches, then the rest; deprecated terms and terms without an ID come last.
   */
  search(query: string, options: SearchOptions = {}): SearchResult {
    const q = labels.normalise(query);
    const qid = query.trim().toLowerCase();
    if (!q && !qid) return { terms: [], total: 0 };
    const qWords = words(q);
    const kinds = options.kinds ? new Set(options.kinds) : null;
    const hits: { entry: Entry; rank: number; byId: boolean }[] = [];
    for (const entry of this.entries) {
      if (kinds && !kinds.has(entry.term.kind)) continue;
      const a = idRank(entry, qid);
      const b = q ? labelRank(entry, q, qWords) : null;
      const rank = a === null ? b : b === null ? a : Math.min(a, b);
      if (rank !== null) hits.push({ entry, rank, byId: rank === a });
    }
    const last = (t: Term) => (t.deprecated || t.id === null ? 1 : 0);
    hits.sort((x, y) =>
      last(x.entry.term) - last(y.entry.term) || x.rank - y.rank
      || (x.byId && y.byId ? x.entry.id.localeCompare(y.entry.id) : 0)
      || x.entry.term.label.length - y.entry.term.label.length
      || x.entry.term.label.localeCompare(y.entry.term.label));
    return { terms: hits.slice(0, options.limit ?? 30).map((h) => h.entry.term), total: hits.length };
  }
}
