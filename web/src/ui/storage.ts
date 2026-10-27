/** The editor text kept in browser storage, so a reload does not lose work. */

const KEY = "mermantics-web:draft";

export interface Draft {
  text: string;
  name: string; // file name for downloads and reports
  saved: string; // text as last opened or downloaded, to tell whether there are unsaved edits
}

// Storage can be blocked or full (private windows, strict settings); the page works without it.
export function loadDraft(): Draft | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const draft = JSON.parse(raw) as Partial<Draft>;
    if (typeof draft.text !== "string" || typeof draft.name !== "string" || typeof draft.saved !== "string") return null;
    return draft as Draft;
  } catch {
    return null;
  }
}

export function saveDraft(draft: Draft): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(draft));
  } catch {
    // ignore
  }
}
