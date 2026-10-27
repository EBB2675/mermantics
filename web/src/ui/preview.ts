/**
 * The rendered diagram. Mermaid gives each box the SVG id `<svg id>-flowchart-<node id>-<n>`
 * and each arrow `data-id="L_<src>_<dst>_<k>"`, where k counts all arrows, not those
 * between one pair. So an arrow is found by its two ends and its place among the arrows
 * between them, both in the diagram text and in the SVG.
 *
 * Arrows are thin, so each one gets a wider transparent copy on top that takes the clicks.
 */

import type { Mermaid } from "mermaid";

export type Level = "error" | "warning";

export interface EdgeRef {
  src: string;
  dst: string;
  nth: number; // 0 for the first arrow from src to dst, 1 for the second, ...
}

export interface Highlights {
  nodes: Map<string, Level>;
  edges: { ref: EdgeRef; level: Level }[];
}

let mermaidModule: Promise<Mermaid> | null = null;

function loadMermaid(): Promise<Mermaid> {
  mermaidModule ??= import("mermaid").then(({ default: m }) => {
    m.initialize({ startOnLoad: false, securityLevel: "strict", theme: "default" });
    return m;
  });
  return mermaidModule;
}

export class Preview {
  private readonly canvas: HTMLElement;
  private readonly message: HTMLElement;
  private svgId = "";
  private nodeEls = new Map<string, Element>();
  private renders = 0;
  private pending: string | null = null;
  private recenter = true;
  private busy = false;
  private scale = 1; // 0 = fit to width
  private onRendered: (text: string) => void = () => {};

  constructor(private readonly root: HTMLElement, private readonly onNodeClick: (nodeId: string) => void,
              private readonly onEdgeClick: (dataId: string) => void) {
    this.canvas = root.querySelector(".preview-canvas")!;
    this.message = root.querySelector(".preview-message")!;
    this.canvas.addEventListener("click", (event) => {
      const target = event.target as Element;
      const node = target.closest("g.node");
      const id = node && this.nodeIdOf(node);
      if (id) {
        this.onNodeClick(id);
        return;
      }
      const edge = target.closest("[data-hit-for]")?.getAttribute("data-hit-for")
        ?? target.closest(".edgeLabel .label[data-id]")?.getAttribute("data-id");
      if (edge) this.onEdgeClick(edge);
    });
    root.querySelector(".zoom-in")!.addEventListener("click", () => this.zoom(1.25));
    root.querySelector(".zoom-out")!.addEventListener("click", () => this.zoom(0.8));
    root.querySelector(".zoom-fit")!.addEventListener("click", () => this.setScale(0));
    root.querySelector(".zoom-reset")!.addEventListener("click", () => this.setScale(1));
  }

  /** Called with the diagram text each time a render has finished. */
  set rendered(fn: (text: string) => void) {
    this.onRendered = fn;
  }

  /**
   * Render `text`. Renders run one at a time; only the newest waiting text is rendered.
   * `recenter` scrolls to the top middle (a new diagram); otherwise the view stays where it is.
   */
  render(text: string, recenter = false): void {
    this.pending = text;
    this.recenter ||= recenter;
    if (!this.busy) void this.drain();
  }

  private async drain() {
    this.busy = true;
    while (this.pending !== null) {
      const text = this.pending;
      this.pending = null;
      await this.renderNow(text);
    }
    this.busy = false;
  }

  private async renderNow(text: string) {
    const mermaid = await loadMermaid();
    const id = `diagram-${++this.renders}`;
    try {
      await mermaid.parse(text);
      const { svg, bindFunctions } = await mermaid.render(id, text);
      this.canvas.innerHTML = svg;
      bindFunctions?.(this.canvas);
      this.svgId = id;
      this.indexNodes();
      this.addEdgeHits();
      this.applyScale();
      if (this.recenter) {
        this.recenter = false;
        this.canvas.scrollTop = 0;
        this.canvas.scrollLeft = (this.canvas.scrollWidth - this.canvas.clientWidth) / 2;
      }
      this.showMessage("");
      this.canvas.classList.remove("stale");
      this.onRendered(text);
    } catch (exc) {
      // Mermaid can leave its error output in the page; keep the last good drawing instead.
      document.getElementById(`d${id}`)?.remove();
      this.canvas.classList.add("stale");
      this.showMessage(`Mermaid cannot draw this: ${(exc as Error).message ?? exc}`);
    }
  }

  private showMessage(text: string) {
    this.message.textContent = text;
    this.message.hidden = !text;
  }

  private nodeIdOf(el: Element): string | null {
    const prefix = `${this.svgId}-flowchart-`;
    if (!el.id.startsWith(prefix)) return null;
    return el.id.slice(prefix.length).replace(/-\d+$/, "");
  }

  private indexNodes() {
    this.nodeEls.clear();
    for (const el of this.canvas.querySelectorAll("g.node")) {
      const id = this.nodeIdOf(el);
      if (id) this.nodeEls.set(id, el);
    }
  }

  private addEdgeHits() {
    for (const path of this.canvas.querySelectorAll("path[data-id]")) {
      const hit = document.createElementNS("http://www.w3.org/2000/svg", "path");
      hit.setAttribute("d", path.getAttribute("d") ?? "");
      hit.setAttribute("class", "edge-hit");
      hit.setAttribute("data-hit-for", path.getAttribute("data-id")!);
      path.after(hit);
    }
  }

  private edgePath(ref: EdgeRef): Element | undefined {
    const prefix = `L_${ref.src}_${ref.dst}_`;
    const paths = [...this.canvas.querySelectorAll("path[data-id]")].filter((p) => {
      const dataId = p.getAttribute("data-id")!;
      return dataId.startsWith(prefix) && /^\d+$/.test(dataId.slice(prefix.length));
    });
    return paths[ref.nth];
  }

  /** The SVG data-id of an arrow, to tell which arrow a click was on. */
  dataIdOf(ref: EdgeRef): string | null {
    return this.edgePath(ref)?.getAttribute("data-id") ?? null;
  }

  private edgeEls(ref: EdgeRef): Element[] {
    const path = this.edgePath(ref);
    if (!path) return [];
    const label = this.canvas.querySelector(`.edgeLabel .label[data-id="${path.getAttribute("data-id")}"]`);
    return label ? [path, label.closest(".edgeLabel")!] : [path];
  }

  highlight(h: Highlights | null) {
    for (const el of this.canvas.querySelectorAll(".hl-error, .hl-warning")) {
      el.classList.remove("hl-error", "hl-warning");
    }
    if (!h) return;
    for (const [id, level] of h.nodes) this.nodeEls.get(id)?.classList.add(`hl-${level}`);
    for (const { ref, level } of h.edges) {
      for (const el of this.edgeEls(ref)) {
        if (!el.classList.contains("hl-error")) el.classList.add(`hl-${level}`);
      }
    }
  }

  /** Mark one box or arrow as selected and scroll it into view. */
  select(target: { nodeId: string } | { edge: EdgeRef } | null) {
    for (const el of this.canvas.querySelectorAll(".is-selected")) el.classList.remove("is-selected");
    if (!target) return;
    const els = "nodeId" in target ? [this.nodeEls.get(target.nodeId)].filter((e) => e !== undefined)
      : this.edgeEls(target.edge);
    for (const el of els) el.classList.add("is-selected");
    els[0]?.scrollIntoView({ block: "center", inline: "center", behavior: "smooth" });
  }

  private zoom(factor: number) {
    const svg = this.canvas.querySelector("svg");
    if (!svg) return;
    const current = this.scale || svg.getBoundingClientRect().width / this.naturalWidth(svg);
    this.setScale(Math.min(4, Math.max(0.1, current * factor)));
  }

  private setScale(scale: number) {
    this.scale = scale;
    this.applyScale();
  }

  private naturalWidth(svg: SVGSVGElement): number {
    return svg.viewBox.baseVal?.width || svg.getBoundingClientRect().width || 1;
  }

  private applyScale() {
    const svg = this.canvas.querySelector("svg");
    if (!svg) return;
    if (this.scale === 0) {
      svg.style.width = "100%";
      svg.style.maxWidth = `${this.naturalWidth(svg)}px`;
    } else {
      svg.style.width = `${this.naturalWidth(svg) * this.scale}px`;
      svg.style.maxWidth = "none";
    }
    svg.style.height = "auto";
  }
}
