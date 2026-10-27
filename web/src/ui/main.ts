/** The page: editor, preview and findings, with the checker running in a worker. */

import "./style.css";

import simulation from "../../../tests/fixtures/simulation-data-model.mmd?raw";
import brokenA from "../../../tests/fixtures/broken-a-unknown-id.mmd?raw";
import brokenB from "../../../tests/fixtures/broken-b-impossible-class.mmd?raw";
import brokenC from "../../../tests/fixtures/broken-c-wrong-relation.mmd?raw";
import type { Finding } from "../core/model.js";
import type { Checked, OntologyInfo, Request, Response } from "../worker/protocol.js";
import { Editor, type LineLevel } from "./editor.js";
import { download, pickFile, stem } from "./files.js";
import { FindingsPanel } from "./findings.js";
import { Preview, type EdgeRef, type Highlights } from "./preview.js";
import { loadDraft, saveDraft, type Draft } from "./storage.js";

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

const editor = new Editor({
  parent: $("#editor"),
  text: draft.text,
  onChange: (text) => textChanged(text, false),
  onDropFile: (file) => void openFile(file),
});
const preview = new Preview($("#preview"), (nodeId) => {
  const node = current()?.nodes.find((n) => n.id === nodeId);
  if (node) editor.goToLine(node.line);
});
const panel = new FindingsPanel($("#findings"), selectFinding);

preview.rendered = (text) => {
  renderedText = text;
  applyHighlights();
};

function textChanged(text: string, now: boolean) {
  draft.text = text;
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
}

function edgeRef(c: Checked, index: number): EdgeRef | null {
  const edge = c.edges[index];
  if (!edge) return null;
  const nth = c.edges.slice(0, index).filter((e) => e.src === edge.src && e.dst === edge.dst).length;
  return { src: edge.src, dst: edge.dst, nth };
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
    const ref = f.edgeIndex !== undefined ? edgeRef(c, f.edgeIndex) : null;
    if (ref) h.edges.push({ ref, level });
  }
  preview.highlight(h);
}

function selectFinding(f: Finding) {
  if (checked && checked.text === renderedText) {
    const ref = f.edgeIndex !== undefined ? edgeRef(checked.checked, f.edgeIndex) : null;
    preview.select(f.nodeId !== undefined ? { nodeId: f.nodeId } : ref ? { edge: ref } : null);
  }
  if (f.line !== undefined && current()) editor.goToLine(f.line);
}

// ---- diagram files -------------------------------------------------------------------------

function replaceDiagram(name: string, text: string) {
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
    status.textContent = ontology.title;
    status.title = `${ontology.triples.toLocaleString("en")} triples, loaded in ${Math.round(ontology.ms)} ms\n${ontology.name}`;
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
preview.render(draft.text, true);
panel.showMessage("Loading the ontology...");
void loadOntology(PMDCO);
