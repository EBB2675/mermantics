/** Messages between the page and the checker worker. Types only, so the page does not pull in the core. */

import type { Result } from "../core/checks.js";
import type { SearchResult, Term } from "../core/terms.js";

export type Request =
  // Load an ontology from a URL (the bundled PMDco) or from text (a local file).
  | { type: "load"; id: number; name: string; title: string; url?: string; text?: string }
  // Run the fast checks on a diagram against the loaded ontology.
  | { type: "check"; id: number; text: string; diagramName: string }
  // Search the loaded ontology's terms by label words or ID (for the form editor).
  | { type: "search"; id: number; query: string; kinds?: string[]; limit?: number }
  // Look up terms by ID; null for IDs the ontology does not have.
  | { type: "terms"; id: number; ids: string[] };

export interface OntologyInfo {
  name: string; // what the reports show as the ontology file
  title: string; // what the page shows
  version: string; // owl:versionInfo or owl:versionIRI of the ontology, or ""
  triples: number;
  terms: number; // in the search index
  ms: number;
}

export interface Checked {
  result: Result;
  summary: string;
  // Arrows and boxes as the checker read them, to find them in the rendered diagram.
  edges: { src: string; dst: string }[];
  nodes: { id: string; line: number }[];
  markdown: string;
  json: string;
  turtle: string;
  ms: number;
}

export type Response =
  | { type: "loaded"; id: number; ontology: OntologyInfo }
  | { type: "checked"; id: number; checked: Checked }
  | { type: "found"; id: number; result: SearchResult }
  | { type: "terms"; id: number; terms: (Term | null)[] }
  | { type: "error"; id: number; request: Request["type"]; message: string };
