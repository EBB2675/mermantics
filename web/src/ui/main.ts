/** The page: forms and editor, preview and findings, with the checker running in a worker. */

import "./style.css";

import simulation from "../../../tests/fixtures/simulation-data-model.mmd?raw";
import brokenA from "../../../tests/fixtures/broken-a-unknown-id.mmd?raw";
import brokenB from "../../../tests/fixtures/broken-b-impossible-class.mmd?raw";
import brokenC from "../../../tests/fixtures/broken-c-wrong-relation.mmd?raw";
import * as edit from "../core/edit.js";
import { parse, type Diagram } from "../core/mermaid.js";
import { defaultConfig, type Finding } from "../core/model.js";
import type { SearchResult, Term } from "../core/terms.js";
import type { Checked, OntologyInfo, Request, Response } from "../worker/protocol.js";
import { Editor, type LineLevel } from "./editor.js";
import { download, pickFile, stem } from "./files.js";
import { FindingsPanel } from "./findings.js";
import { FormsPanel, type Level } from "./forms.js";
import { Preview, type EdgeRef, type Highlights } from "./preview.js";
import { loadDraft, loadSetting, saveDraft, saveSetting, type Draft } from "./storage.js";

const EXAMPLES = [
  { name: "simulation-data-model.mmd", title: "Simulation data model", text: simulation },
  { name: "broken-a-unknown-id.mmd", title: "Broken: unknown ID", text: brokenA },
  { name: "broken-b-impossible-class.mmd", title: "Broken: impossible class (full check only)", text: brokenB },
  { name: "broken-c-wrong-relation.mmd", title: "Broken: wrong relation", text: brokenC },
] as const;

const PMDCO = {
  name: "https://raw.githubusercontent.com/materialdigital/core-ontology/v3.1.1/pmdco-full.ttl",
  title: "PMDco 3.1.1",
  url: new URL(`${import.meta.env.BASE_URL}ontology/pmdco-full-3.1.1.ttl`, location.href).href,
};

const PREVIEW_DELAY = 300;
const config = defaultConfig();
const CHECK_DELAY = 500;

const $ = <T extends HTMLElement = HTMLElement>(selector: string) => document.querySelector<T>(selector)!;

// ---- worker --------------------------------------------------------------------------------

type WithoutId<T> = T extends unknown ? Omit<T, "id"> : never;

const worker = new Worker(new URL("../worker/checker.worker.ts", import.meta.url), { type: "module" });
const waiting = new Map<number, { resolve: (r: Response) => void; reject: (e: Error) => void }>();
let requests = 0;

worker.onmessage = (event: MessageEvent<Response>) => {
  const reply = event.data;
  const w = waiting.get(reply.id);
  waiting.delete(reply.id);
  if (reply.type === "error") w?.reject(new Error(reply.message));
  else w?.resolve(reply);
};

function ask(request: WithoutId<Request>): Promise<Response> {
  const id = ++requests;
  return new Promise((resolve, reject) => {
    waiting.set(id, { resolve, reject });
    worker.postMessage({ ...request, id });
  });
}

// ---- state ---------------------------------------------------------------------------------

const draft: Draft = loadDraft() ?? { name: EXAMPLES[0].name, text: EXAMPLES[0].text, saved: EXAMPLES[0].text };
let ontology: OntologyInfo | null = null;
let checked: { checked: Checked; text: string; name: string } | null = null;
let renderedText: string | null = null;
let checkRuns = 0;
let checkTimer = 0;
let previewTimer = 0;
let draftTimer = 0;
let terms = new Map<string, Promise<Term | null>>();

// The two texts the page parses: the editor text and the text the preview shows.
const parsed: { text: string; diagram: Diagram }[] = [];

function diagramOf(text: string): Diagram {
  let hit = parsed.find((p) => p.text === text);
  if (!hit) {
    hit = { text, diagram: parse(text) };
    parsed.unshift(hit);
    parsed.length = Math.min(parsed.length, 2);
  }
  return hit.diagram;
}

const editor = new Editor({
  parent: $("#editor"),
  text: draft.text,
  onChange: (text) => textChanged(text, false),
  onDropFile: (file) => void openFile(file),
});
const preview = new Preview($("#preview"), (nodeId) => openTarget({ nodeId }), (dataId) => {
  const edgeIndex = renderedText === editor.text ? edgeIndexOf(dataId) : null;
  if (edgeIndex !== null) openTarget({ edgeIndex });
});
const panel = new FindingsPanel($("#findings"), selectFinding);
const forms = new FormsPanel($("#forms"), {
  text: () => editor.text,
  diagram: () => diagramOf(editor.text),
  apply: (changes) => editor.apply(changes),
  search: searchTerms,
  lookup: (ids) => Promise.all(ids.map(lookupTerm)),
  levels: findingLevels,
  select: (target) => {
    pendingSelect = target;
    selectPending();
  },
  showLine: (line) => {
    setTab("text");
    editor.goToLine(line);
  },
  undo: () => editor.undo(),
  redo: () => editor.redo(),
}, config);

preview.rendered = (text) => {
  renderedText = text;
  applyHighlights();
  selectPending();
};

// ---- tabs: forms or text -------------------------------------------------------------------

type Tab = "forms" | "text";
let tab: Tab = loadSetting("tab") === "text" ? "text" : "forms";

function setTab(next: Tab) {
  tab = next;
  saveSetting("tab", next);
  for (const t of ["forms", "text"] as const) {
    $(`#tab-${t}`).setAttribute("aria-selected", String(t === next));
  }
  $("#forms").hidden = next !== "forms";
  $("#editor").hidden = next !== "text";
  if (next === "text") editor.refresh();
  else forms.refresh();
}

$("#tab-forms").addEventListener("click", () => setTab("forms"));
$("#tab-text").addEventListener("click", () => setTab("text"));

/** A box or arrow was clicked (preview or findings): open its form, or show its line in the text. */
function openTarget(target: { nodeId?: string; edgeIndex?: number; line?: number }) {
  const d = diagramOf(editor.text);
  if (tab === "forms") {
    if (target.nodeId !== undefined && d.nodes.has(target.nodeId)) return forms.openBox(target.nodeId);
    if (target.edgeIndex !== undefined && d.edges[target.edgeIndex]) return forms.openArrow(target.edgeIndex);
    if (target.line === undefined) return;
    // A line that is not a box or an arrow (e.g. one the parser did not understand).
    setTab("text");
  }
  const line = target.line
    ?? (target.nodeId !== undefined ? d.nodes.get(target.nodeId)?.line : undefined)
    ?? (target.edgeIndex !== undefined ? d.edges[target.edgeIndex]?.line : undefined);
  if (line !== undefined) editor.goToLine(line);
}

// Ctrl+Z outside the editor undoes form edits too (they are editor transactions).
document.addEventListener("keydown", (event) => {
  if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
  const key = event.key.toLowerCase();
  if (key !== "z" && key !== "y") return;
  const target = event.target as HTMLElement;
  if (target.closest("input, textarea, select, .cm-editor")) return;
  event.preventDefault();
  if (key === "y" || event.shiftKey) editor.redo();
  else editor.undo();
});

// ---- ontology terms for the forms ----------------------------------------------------------

async function searchTerms(query: string, kinds: string[]): Promise<SearchResult> {
  const reply = await ask({ type: "search", query, kinds, limit: 30 });
  return reply.type === "found" ? reply.result : { terms: [], total: 0 };
}

function lookupTerm(id: string): Promise<Term | null> {
  let term = terms.get(id);
  if (!term) {
    term = ask({ type: "terms", ids: [id] }).then((r) => (r.type === "terms" ? r.terms[0] ?? null : null));
    // Before the ontology is loaded there is nothing to remember.
    if (ontology) terms.set(id, term);
  }
  return term;
}

function textChanged(text: string, now: boolean) {
  draft.text = text;
  if (tab === "forms") forms.refresh();
  showDocName();
  clearTimeout(draftTimer);
  draftTimer = window.setTimeout(() => saveDraft(draft), now ? 0 : PREVIEW_DELAY);
  clearTimeout(previewTimer);
  previewTimer = window.setTimeout(() => preview.render(text), now ? 0 : PREVIEW_DELAY);
  clearTimeout(checkTimer);
  checkTimer = window.setTimeout(() => void runCheck(), now ? 0 : CHECK_DELAY);
}

function dirty(): boolean {
  return draft.text !== draft.saved;
}

function showDocName() {
  $("#docname").textContent = draft.name + (dirty() ? " (edited)" : "");
}

/** The last check result, if it belongs to the text now in the editor. */
function current(): Checked | null {
  return checked && checked.text === editor.text ? checked.checked : null;
}

// ---- checks --------------------------------------------------------------------------------

async function runCheck(): Promise<Checked | null> {
  clearTimeout(checkTimer);
  if (ontology === null) return null;
  const run = ++checkRuns;
  const text = editor.text;
  const name = draft.name;
  $("#check-status").textContent = "checking...";
  try {
    const reply = await ask({ type: "check", text, diagramName: name });
    if (run !== checkRuns || reply.type !== "checked") return null;
    checked = { checked: reply.checked, text, name };
    showChecked(reply.checked);
    return reply.checked;
  } catch (exc) {
    if (run === checkRuns) {
      panel.showMessage(`The check failed: ${(exc as Error).message}`);
      $("#check-status").textContent = "";
    }
    return null;
  }
}

const SEVERE: Partial<Record<Finding["level"], LineLevel>> = { error: "error", warning: "warning" };

function showChecked(c: Checked) {
  const passed = !c.result.findings.some((f) => f.level === "error");
  panel.show(c.result.findings, c.summary, passed);
  $("#check-status").textContent = `fast checks in ${Math.round(c.ms)} ms`;
  const lines = new Map<number, LineLevel>();
  for (const f of c.result.findings) {
    const level = SEVERE[f.level];
    if (level && f.line !== undefined && lines.get(f.line) !== "error") lines.set(f.line, level);
  }
  editor.setMarks(lines);
  applyHighlights();
  if (tab === "forms") forms.refresh();
}

function edgeRef(edges: { src: string; dst: string }[], index: number): EdgeRef | null {
  const edge = edges[index];
  if (!edge) return null;
  const nth = edges.slice(0, index).filter((e) => e.src === edge.src && e.dst === edge.dst).length;
  return { src: edge.src, dst: edge.dst, nth };
}

/** The arrow (index in the drawn diagram) that has this SVG data-id. */
function edgeIndexOf(dataId: string): number | null {
  const edges = diagramOf(renderedText ?? "").edges;
  for (let i = 0; i < edges.length; i++) {
    const ref = edgeRef(edges, i);
    if (ref && preview.dataIdOf(ref) === dataId) return i;
  }
  return null;
}

function findingLevels(): { nodes: Map<string, Level>; edges: Map<number, Level> } | null {
  const c = current();
  if (!c) return null;
  const out = { nodes: new Map<string, Level>(), edges: new Map<number, Level>() };
  for (const f of c.result.findings) {
    const level = SEVERE[f.level];
    if (!level) continue;
    if (f.nodeId !== undefined && out.nodes.get(f.nodeId) !== "error") out.nodes.set(f.nodeId, level);
    if (f.edgeIndex !== undefined && out.edges.get(f.edgeIndex) !== "error") out.edges.set(f.edgeIndex, level);
  }
  return out;
}

// A box or arrow to mark in the preview once it shows the editor text.
let pendingSelect: { nodeId: string } | { edgeIndex: number } | null = null;

function selectPending() {
  if (!pendingSelect || renderedText !== editor.text) return;
  const target = pendingSelect;
  pendingSelect = null;
  if ("nodeId" in target) {
    preview.select(target);
  } else {
    const ref = edgeRef(diagramOf(editor.text).edges, target.edgeIndex);
    preview.select(ref ? { edge: ref } : null);
  }
}

/** Highlight boxes and arrows only when the drawing and the findings are of the same text. */
function applyHighlights() {
  if (!checked || checked.text !== renderedText) {
    preview.highlight(null);
    return;
  }
  const c = checked.checked;
  const h: Highlights = { nodes: new Map(), edges: [] };
  for (const f of c.result.findings) {
    const level = SEVERE[f.level];
    if (!level) continue;
    if (f.nodeId !== undefined && h.nodes.get(f.nodeId) !== "error") h.nodes.set(f.nodeId, level);
    const ref = f.edgeIndex !== undefined ? edgeRef(c.edges, f.edgeIndex) : null;
    if (ref) h.edges.push({ ref, level });
  }
  preview.highlight(h);
}

function selectFinding(f: Finding) {
  if (checked && checked.text === renderedText) {
    const ref = f.edgeIndex !== undefined ? edgeRef(checked.checked.edges, f.edgeIndex) : null;
    preview.select(f.nodeId !== undefined ? { nodeId: f.nodeId } : ref ? { edge: ref } : null);
  }
  if (current()) openTarget({ nodeId: f.nodeId, edgeIndex: f.edgeIndex, line: f.line });
}

// ---- diagram files -------------------------------------------------------------------------

function replaceDiagram(name: string, text: string) {
  forms.reset();
  draft.name = name;
  draft.saved = text;
  editor.setText(text);
  preview.render(text, true);
  textChanged(text, true);
}

function mayReplace(): boolean {
  return !dirty() || confirm(`Replace your unsaved edits to ${draft.name}?`);
}

async function openFile(file: File) {
  if (!mayReplace()) return;
  replaceDiagram(file.name, await file.text());
}

function saveDiagram() {
  download(draft.name, editor.text, "text/plain");
  draft.saved = editor.text;
  saveDraft(draft);
  showDocName();
}

const examples = $<HTMLSelectElement>("#examples");
for (const [i, example] of EXAMPLES.entries()) examples.add(new Option(example.title, String(i)));
examples.addEventListener("change", () => {
  const example = EXAMPLES[Number(examples.value)];
  examples.value = "";
  if (example && mayReplace()) replaceDiagram(example.name, example.text);
});

$("#new").addEventListener("click", () => {
  if (mayReplace()) replaceDiagram("diagram.mmd", edit.TEMPLATE);
});
$("#open").addEventListener("click", async () => {
  const file = await pickFile(".mmd,.mermaid,.txt,.md");
  if (file) await openFile(file);
});
$("#save").addEventListener("click", saveDiagram);
document.addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key === "s") {
    event.preventDefault();
    saveDiagram();
  }
});

// ---- reports -------------------------------------------------------------------------------

async function downloadReport(kind: "markdown" | "json" | "turtle") {
  const c = current() && checked!.name === draft.name ? checked!.checked : await runCheck();
  if (!c) return;
  const base = stem(draft.name);
  if (kind === "markdown") download(`${base}-report.md`, c.markdown, "text/markdown");
  else if (kind === "json") download(`${base}-report.json`, c.json + "\n", "application/json");
  else download(`${base}.ttl`, c.turtle, "text/turtle");
}

$("#report-md").addEventListener("click", () => void downloadReport("markdown"));
$("#report-json").addEventListener("click", () => void downloadReport("json"));
$("#report-owl").addEventListener("click", () => void downloadReport("turtle"));

// ---- ontology ------------------------------------------------------------------------------

async function loadOntology(request: { name: string; title: string; url?: string; text?: string }) {
  const status = $("#onto-status");
  const previous = status.textContent;
  status.textContent = `loading ${request.title}...`;
  status.classList.remove("failed");
  try {
    const reply = await ask({ type: "load", ...request });
    if (reply.type !== "loaded") return;
    ontology = reply.ontology;
    terms = new Map();
    status.textContent = ontology.title;
    status.title = `${ontology.triples.toLocaleString("en")} triples, ${ontology.terms.toLocaleString("en")} terms, ` +
      `loaded in ${Math.round(ontology.ms)} ms\n${ontology.name}`;
    $("#onto-default").hidden = ontology.name === PMDCO.name;
    $("#onto-version").textContent = `ontology ${ontology.title}` + (ontology.version ? ` (version ${ontology.version})` : "");
    void runCheck();
  } catch (exc) {
    status.textContent = ontology ? previous : "no ontology";
    status.classList.add("failed");
    alert(`Could not load ${request.title}: ${(exc as Error).message}`);
  }
}

$("#onto-load").addEventListener("click", async () => {
  const file = await pickFile(".ttl,.nt,.n3,.trig");
  if (file) await loadOntology({ name: file.name, title: file.name, text: await file.text() });
});
$("#onto-default").addEventListener("click", () => void loadOntology(PMDCO));

// ---- start ---------------------------------------------------------------------------------

$("#app-version").textContent = `mermantics-web ${__APP_VERSION__}`;
showDocName();
setTab(tab);
preview.render(draft.text, true);
panel.showMessage("Loading the ontology...");
void loadOntology(PMDCO);
