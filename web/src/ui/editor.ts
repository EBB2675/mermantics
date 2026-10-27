/** The diagram editor: CodeMirror 6 with marks on the lines that have findings. */

import { EditorState, RangeSetBuilder, StateEffect, StateField } from "@codemirror/state";
import { Decoration, EditorView, type DecorationSet } from "@codemirror/view";
import { basicSetup } from "codemirror";

export type LineLevel = "error" | "warning";

const setMarks = StateEffect.define<Map<number, LineLevel>>();

// Line marks move with the text while the user types, until the next check replaces them.
const marks = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    value = value.map(tr.changes);
    for (const effect of tr.effects) {
      if (!effect.is(setMarks)) continue;
      const builder = new RangeSetBuilder<Decoration>();
      for (const [line, level] of [...effect.value].sort((a, b) => a[0] - b[0])) {
        if (line < 1 || line > tr.state.doc.lines) continue;
        builder.add(tr.state.doc.line(line).from, tr.state.doc.line(line).from,
                    Decoration.line({ class: `cm-finding-${level}` }));
      }
      value = builder.finish();
    }
    return value;
  },
  provide: (field) => EditorView.decorations.from(field),
});

export interface EditorOptions {
  parent: HTMLElement;
  text: string;
  onChange: (text: string) => void;
  onDropFile: (file: File) => void;
}

export class Editor {
  private readonly view: EditorView;

  constructor(private readonly options: EditorOptions) {
    this.view = new EditorView({ parent: options.parent, state: this.state(options.text) });
  }

  private state(text: string): EditorState {
    return EditorState.create({
      doc: text,
      extensions: [
        basicSetup,
        EditorView.lineWrapping,
        marks,
        EditorView.updateListener.of((update) => {
          if (update.docChanged) this.options.onChange(update.state.doc.toString());
        }),
        EditorView.domEventHandlers({
          drop: (event) => {
            const file = event.dataTransfer?.files[0];
            if (!file) return false;
            event.preventDefault();
            this.options.onDropFile(file);
            return true;
          },
        }),
      ],
    });
  }

  get text(): string {
    return this.view.state.doc.toString();
  }

  /** Replace the whole text, with a fresh undo history (a new file or example). */
  setText(text: string): void {
    this.view.setState(this.state(text));
  }

  setMarks(lines: Map<number, LineLevel>): void {
    this.view.dispatch({ effects: setMarks.of(lines) });
  }

  goToLine(number: number): void {
    const doc = this.view.state.doc;
    if (number < 1 || number > doc.lines) return;
    const line = doc.line(number);
    this.view.dispatch({
      selection: { anchor: line.from, head: line.to },
      effects: EditorView.scrollIntoView(line.from, { y: "center" }),
    });
    this.view.focus();
  }
}
