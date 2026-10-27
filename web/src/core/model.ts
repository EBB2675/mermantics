/** Shared data structures: configuration, diagram elements and findings. */

export const OBO_BASE = "http://purl.obolibrary.org/obo/";
export const DEFAULT_PREFIXES: Readonly<Record<string, string>> = { PMD: "https://w3id.org/pmd/co/PMD_" };
export const DEFAULT_LOCAL_NS = "http://example.org/diagram#";

// Finding levels, most severe first.
export const ERROR = "error";
export const WARNING = "warning";
export const NOTE = "note";
export const OK = "ok";
export type Level = typeof ERROR | typeof WARNING | typeof NOTE | typeof OK;
export const LEVELS: readonly Level[] = [ERROR, WARNING, NOTE, OK];

/** How to read a diagram. All conventions live here so they can be changed in one place. */
export interface Config {
  prefixes: Record<string, string>;
  // "parent-child": `Parent --> Child` means Child subClassOf Parent.
  // "child-parent": `Child --> Parent` means Child subClassOf Parent.
  inheritDirection: "parent-child" | "child-parent";
  // Nodes with these style classes are ignored completely (e.g. the legend).
  skipClasses: Set<string>;
  // Nodes with these style classes are vocabularies: not reasoned over, but checked
  // against the class of the node that points at them.
  vocabClasses: Set<string>;
  localNs: string;
}

export function defaultConfig(overrides: Partial<Config> = {}): Config {
  return {
    prefixes: { ...DEFAULT_PREFIXES },
    inheritDirection: "parent-child",
    skipClasses: new Set(["note"]),
    vocabClasses: new Set(["vocab"]),
    localNs: DEFAULT_LOCAL_NS,
    ...overrides,
  };
}

export interface Node {
  id: string;
  label: string; // raw label text as written in the diagram
  line: number;
  css: Set<string>;
  defined: boolean; // false if the node only appears inside an arrow
}

export interface Edge {
  src: string;
  dst: string;
  kind: "inherit" | "relation"; // "inherit" is an unlabelled solid arrow
  label: string;
  line: number;
  arrow: string; // the arrow as written, for messages
}

export interface Finding {
  level: Level;
  check: string;
  message: string;
  where: string;
  details: string;
  // Structured location, for the web page. Not part of the JSON report.
  nodeId?: string;
  edgeIndex?: number;
  line?: number;
}

export interface Location {
  nodeId?: string;
  edgeIndex?: number;
  line?: number;
}

export function finding(level: Level, check: string, message: string, where = "", details = "",
                        location: Location = {}): Finding {
  return { level, check, message, where, details, ...location };
}

export function findingAsDict(f: Finding) {
  return { level: f.level, check: f.check, where: f.where, message: f.message, details: f.details };
}
