/** Building small pieces of DOM without a framework. */

export type Child = Node | string | null | undefined | false;

/** `h("button", { class: "x", disabled: true }, "Save")`. Attributes that are false or null are left out. */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K, attrs: Record<string, string | number | boolean | null | undefined> = {}, ...children: Child[]
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) {
    if (value === false || value === null || value === undefined) continue;
    e.setAttribute(name, value === true ? "" : String(value));
  }
  for (const child of children) if (child !== null && child !== undefined && child !== false) e.append(child);
  return e;
}
