/**
 * Looking things up in an ontology (labels, kinds, hierarchy).
 *
 * The ontology is parsed once into the default graph of an N3 Store and never copied.
 * The local model of a diagram is added to the same Store in its own named graph and
 * removed again afterwards (see `withLocalModel`), so a check run costs a few hundred
 * quads, not a copy of the ontology.
 *
 * Unlike the Python version, core does no downloading and cannot follow owl:imports:
 * the caller passes Turtle text or a ready Store. `unresolvedImports` lists the imports
 * that are not in the Store, so the checks can say so.
 */

import { DataFactory, Parser, Store } from "n3";
import type { Quad, Quad_Graph, Term } from "@rdfjs/types";

const { namedNode, defaultGraph } = DataFactory;

const RDF_NS = "http://www.w3.org/1999/02/22-rdf-syntax-ns#";
const RDFS_NS = "http://www.w3.org/2000/01/rdf-schema#";
const OWL_NS = "http://www.w3.org/2002/07/owl#";
const SKOS_NS = "http://www.w3.org/2004/02/skos/core#";

export const RDF = {
  type: namedNode(`${RDF_NS}type`),
  first: namedNode(`${RDF_NS}first`),
  rest: namedNode(`${RDF_NS}rest`),
};
export const RDFS = {
  label: namedNode(`${RDFS_NS}label`),
  subClassOf: namedNode(`${RDFS_NS}subClassOf`),
  subPropertyOf: namedNode(`${RDFS_NS}subPropertyOf`),
  domain: namedNode(`${RDFS_NS}domain`),
  range: namedNode(`${RDFS_NS}range`),
  Class: namedNode(`${RDFS_NS}Class`),
};
export const OWL = {
  Thing: namedNode(`${OWL_NS}Thing`),
  Class: namedNode(`${OWL_NS}Class`),
  Ontology: namedNode(`${OWL_NS}Ontology`),
  NamedIndividual: namedNode(`${OWL_NS}NamedIndividual`),
  ObjectProperty: namedNode(`${OWL_NS}ObjectProperty`),
  DatatypeProperty: namedNode(`${OWL_NS}DatatypeProperty`),
  AnnotationProperty: namedNode(`${OWL_NS}AnnotationProperty`),
  deprecated: namedNode(`${OWL_NS}deprecated`),
  unionOf: namedNode(`${OWL_NS}unionOf`),
  intersectionOf: namedNode(`${OWL_NS}intersectionOf`),
  equivalentClass: namedNode(`${OWL_NS}equivalentClass`),
  equivalentProperty: namedNode(`${OWL_NS}equivalentProperty`),
  inverseOf: namedNode(`${OWL_NS}inverseOf`),
  imports: namedNode(`${OWL_NS}imports`),
  versionIRI: namedNode(`${OWL_NS}versionIRI`),
};
export const SKOS = { prefLabel: namedNode(`${SKOS_NS}prefLabel`) };

/** The named graph that holds the local model while checks run. */
export const LOCAL_GRAPH = namedNode("urn:mermantics:local-model");

const DEPRECATED_PREFIXES = ["obsolete", "deprecated"];

export class OntologyError extends Error {}

export interface OntologySource {
  /** File name or URL, shown in reports and counted as loaded for owl:imports. */
  name: string;
  text: string;
}

/** A term and the property it came from: [expression, source property]. */
export type Constraint = [Term, Term];

/** Python truthiness of `str(value).strip().lower() in ("true", "1")`. */
function isTrue(term: Term): boolean {
  const v = term.value.trim().toLowerCase();
  return v === "true" || v === "1";
}

/** Keep the first of each term, in order. */
function unique(terms: Term[]): Term[] {
  const seen = new Set<string>();
  const out: Term[] = [];
  for (const t of terms) {
    const key = `${t.termType}:${t.value}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(t);
    }
  }
  return out;
}

function termKey(t: Term): string {
  return `${t.termType}:${t.value}`;
}

/** An N3 Store with the lookups the checks need. */
export class Ontology {
  private readonly supersCache = new Map<string, Set<string>>();

  /**
   * @param store  the Store holding the ontology in its default graph
   * @param files  names of the loaded sources, for reports
   * @param graph  the graph to read: the default graph (ontology only) or null (all
   *               graphs, i.e. the ontology plus the local model)
   */
  constructor(readonly store: Store, readonly files: string[] = [],
              readonly graph: Quad_Graph | null = defaultGraph()) {}

  /** Parse Turtle (or N-Triples, N3) sources into one new Store, all in the default graph. */
  static fromTurtle(sources: OntologySource[]): Ontology {
    const store = new Store();
    for (const source of sources) {
      const options = /^[A-Za-z][A-Za-z0-9+.-]*:/.test(source.name) ? { baseIRI: source.name } : {};
      let quads: Quad[];
      try {
        quads = new Parser(options).parse(source.text);
      } catch (exc) {
        throw new OntologyError(`could not parse ${source.name}: ${(exc as Error).message}`);
      }
      for (const q of quads) {
        if (q.graph.termType === "DefaultGraph") store.addQuad(q);
        else store.addQuad(q.subject, q.predicate, q.object, defaultGraph());
      }
    }
    return new Ontology(store, sources.map((s) => s.name));
  }

  /**
   * Add quads to the local-model graph, run `fn` with a view of ontology plus local
   * model, and remove the quads again. The ontology itself is never copied or changed.
   */
  withLocalModel<T>(quads: Quad[], fn: (hierarchy: Ontology) => T): T {
    const local = quads.map((q) => DataFactory.quad(q.subject, q.predicate, q.object, LOCAL_GRAPH));
    const clear = () => this.store.removeQuads(this.store.getQuads(null, null, null, LOCAL_GRAPH));
    clear();
    this.store.addQuads(local);
    try {
      return fn(new Ontology(this.store, this.files, null));
    } finally {
      clear();
    }
  }

  /** owl:imports of the loaded ontology that are not in the Store. An import counts as
   * loaded when it names a loaded ontology (or its version IRI) or a loaded source. */
  unresolvedImports(): string[] {
    const loaded = new Set<string>(this.files);
    for (const o of this.subjects(RDF.type, OWL.Ontology)) {
      loaded.add(o.value);
      for (const v of this.objects(o, OWL.versionIRI)) loaded.add(v.value);
    }
    return unique(this.objects(null, OWL.imports))
      .map((t) => t.value)
      .filter((iri) => !loaded.has(iri));
  }

  // ---- store access ----------------------------------------------------------------

  private objects(subject: Term | null, predicate: Term): Term[] {
    return this.store.getObjects(subject as never, predicate as never, this.graph as never) as Term[];
  }

  private subjects(predicate: Term, object: Term): Term[] {
    return this.store.getSubjects(predicate as never, object as never, this.graph as never) as Term[];
  }

  private has(subject: Term | null, predicate: Term | null, object: Term | null): boolean {
    return this.store.some(() => true, subject as never, predicate as never, object as never, this.graph as never);
  }

  /** rdflib's Graph.value(subject, predicate): one value or null. */
  private value(subject: Term, predicate: Term): Term | null {
    return this.objects(subject, predicate)[0] ?? null;
  }

  // ---- basic lookups -----------------------------------------------------------------

  exists(iri: Term): boolean {
    return this.has(iri, null, null);
  }

  /** English (or untagged) labels; falls back to any language. */
  labels(iri: Term): string[] {
    const preferred: string[] = [];
    const other: string[] = [];
    for (const prop of [RDFS.label, SKOS.prefLabel]) {
      for (const value of this.objects(iri, prop)) {
        if (value.termType !== "Literal") continue;
        const lang = value.language.toLowerCase();
        (lang === "" || lang === "en" || lang.startsWith("en-") ? preferred : other).push(value.value);
      }
    }
    return preferred.length ? preferred : other;
  }

  label(iri: Term): string {
    if (iri.termType === "NamedNode") {
      const labels = this.labels(iri);
      if (labels.length) return labels[0]!;
      const parts = iri.value.split(/[/#]/);
      return parts[parts.length - 1]!;
    }
    return this.describe(iri);
  }

  deprecated(iri: Term): boolean {
    for (const value of this.objects(iri, OWL.deprecated)) {
      if (isTrue(value)) return true;
    }
    return this.objects(iri, RDFS.label).some((lab) => {
      const text = lab.value.trim().toLowerCase();
      return DEPRECATED_PREFIXES.some((p) => text.startsWith(p));
    });
  }

  kind(iri: Term): string {
    const types = new Set(this.objects(iri, RDF.type).map(termKey));
    const is = (t: Term) => types.has(termKey(t));
    if (is(OWL.ObjectProperty)) return "object property";
    if (is(OWL.DatatypeProperty)) return "datatype property";
    if (is(OWL.AnnotationProperty)) return "annotation property";
    if (is(OWL.Class) || is(RDFS.Class)) return "class";
    if (is(OWL.NamedIndividual)) return "individual";
    if (this.has(iri, RDFS.subClassOf, null) || this.has(null, RDFS.subClassOf, iri)) return "class";
    if (this.has(iri, RDFS.subPropertyOf, null)) return "property";
    return "unknown";
  }

  // ---- class expressions -------------------------------------------------------------

  /** Members of the RDF list at `node prop`, like rdflib's Collection. */
  private members(node: Term, prop: Term): Term[] {
    let list: Term | null = this.value(node, prop);
    if (list === null) return [];
    const out: Term[] = [];
    const chain = new Set([termKey(list)]);
    while (list !== null) {
      const item = this.value(list, RDF.first);
      if (item !== null) out.push(item);
      list = this.value(list, RDF.rest);
      if (list !== null) {
        if (chain.has(termKey(list))) throw new OntologyError("List contains a recursive rdf:rest reference");
        chain.add(termKey(list));
      }
    }
    return out;
  }

  /** Short plain-text rendering of a class expression. */
  describe(expr: Term): string {
    if (expr.termType === "NamedNode") return `'${this.label(expr)}'`;
    const union = this.members(expr, OWL.unionOf);
    if (union.length) return union.map((m) => this.describe(m)).join(" or ");
    const inter = this.members(expr, OWL.intersectionOf);
    if (inter.length) return inter.map((m) => this.describe(m)).join(" and ");
    return "a complex class expression";
  }

  /** Is a class with these superclasses inside `expr`? true, false or null (unknown). */
  satisfied(expr: Term, supers: Set<string>): boolean | null {
    if (expr.termType === "NamedNode") return expr.equals(OWL.Thing) || supers.has(expr.value);
    const union = this.members(expr, OWL.unionOf);
    if (union.length) {
      const results = union.map((m) => this.satisfied(m, supers));
      if (results.some((r) => r === true)) return true;
      return results.some((r) => r === null) ? null : false;
    }
    const inter = this.members(expr, OWL.intersectionOf);
    if (inter.length) {
      const results = inter.map((m) => this.satisfied(m, supers));
      if (results.some((r) => r === false)) return false;
      return results.some((r) => r === null) ? null : true;
    }
    return null;
  }

  // ---- hierarchy ---------------------------------------------------------------------

  private *namedParents(cls: Term): Generator<Term> {
    for (const parent of this.objects(cls, RDFS.subClassOf)) {
      if (parent.termType === "NamedNode") {
        yield parent;
      } else if (parent.termType === "BlankNode") {
        for (const member of this.members(parent, OWL.intersectionOf)) {
          if (member.termType === "NamedNode") yield member;
        }
      }
    }
    for (const eq of unique([...this.objects(cls, OWL.equivalentClass), ...this.subjects(OWL.equivalentClass, cls)])) {
      if (eq.termType === "NamedNode") {
        yield eq;
      } else if (eq.termType === "BlankNode") {
        for (const member of this.members(eq, OWL.intersectionOf)) {
          if (member.termType === "NamedNode") yield member;
        }
      }
    }
  }

  /** IRIs of all named superclasses, including the class itself. */
  superclasses(cls: Term): Set<string> {
    const cached = this.supersCache.get(cls.value);
    if (cached) return cached;
    const seen = new Set([cls.value]);
    const stack = [cls];
    while (stack.length) {
      const current = stack.pop()!;
      for (const parent of this.namedParents(current)) {
        if (!seen.has(parent.value)) {
          seen.add(parent.value);
          stack.push(parent);
        }
      }
    }
    this.supersCache.set(cls.value, seen);
    return seen;
  }

  /**
   * Domains and ranges that apply to a property, from the property itself, its
   * super-properties, its inverses and any mix of them (e.g. a super-property of an
   * inverse). Returns two lists of [expression, source].
   */
  propertyConstraints(prop: Term): [Constraint[], Constraint[]] {
    const domains: Constraint[] = [];
    const ranges: Constraint[] = [];
    const seen = new Set<string>();
    // [property, flipped]: flipped means we reached it through an odd number of
    // inverses, so its domain constrains our object and its range our subject.
    const stack: [Term, boolean][] = [[prop, false]];
    while (stack.length) {
      const [p, flipped] = stack.pop()!;
      const key = `${termKey(p)}|${flipped}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (p.termType === "BlankNode") {
        // An anonymous inverse, as in `subPropertyOf [ owl:inverseOf q ]`.
        for (const q of this.objects(p, OWL.inverseOf)) stack.push([q, !flipped]);
        continue;
      }
      const ownDomains: Constraint[] = this.objects(p, RDFS.domain).map((d) => [d, p]);
      const ownRanges: Constraint[] = this.objects(p, RDFS.range).map((r) => [r, p]);
      domains.push(...(flipped ? ownRanges : ownDomains));
      ranges.push(...(flipped ? ownDomains : ownRanges));
      for (const q of this.objects(p, RDFS.subPropertyOf)) stack.push([q, flipped]);
      for (const q of this.objects(p, OWL.equivalentProperty)) stack.push([q, flipped]);
      for (const q of this.subjects(OWL.equivalentProperty, p)) stack.push([q, flipped]);
      const inverses = unique([...this.objects(p, OWL.inverseOf), ...this.subjects(OWL.inverseOf, p)]);
      for (const q of inverses) {
        if (q.termType === "NamedNode") stack.push([q, !flipped]);
      }
    }
    return [domains, ranges];
  }
}
