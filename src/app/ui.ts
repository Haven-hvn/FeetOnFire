// Small DOM helpers for the app's screens.

type Child = Node | string | null | undefined | false;
type Attrs = Record<string, string | number | boolean | ((e: Event) => void) | undefined>;

/** Creates an element: h('button', { class: 'primary', onclick: fn }, 'Play'). */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: (Child | Child[])[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) {
    if (value === undefined || value === false) continue;
    if (typeof value === 'function') el.addEventListener(name.replace(/^on/, ''), value);
    else if (name === 'class') el.className = String(value);
    else if (name in el && name !== 'list') (el as unknown as Record<string, unknown>)[name] = value;
    else el.setAttribute(name, String(value));
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child);
  }
  return el;
}

export function megabytes(bytes: number): string {
  return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${(bytes / 1e6).toFixed(bytes >= 1e7 ? 0 : 1)} MB`;
}

/** A screen: what it shows, and what to undo when it goes away. */
export interface Screen {
  root: HTMLElement;
  /** Key presses while the screen is up; return true when handled. */
  onKey?(e: KeyboardEvent): boolean;
  close?(): void;
}

/** Files of a drop, folders walked. */
export async function droppedFiles(data: DataTransfer): Promise<{ path: string; file: File }[]> {
  interface Entry {
    isFile: boolean;
    isDirectory: boolean;
    fullPath: string;
    file(ok: (f: File) => void, fail: (e: unknown) => void): void;
    createReader(): { readEntries(ok: (entries: Entry[]) => void, fail: (e: unknown) => void): void };
  }
  const out: { path: string; file: File }[] = [];
  const walk = async (entry: Entry): Promise<void> => {
    if (entry.isFile) {
      const file = await new Promise<File>((ok, fail) => entry.file(ok, fail));
      out.push({ path: entry.fullPath.replace(/^\//, ''), file });
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      for (;;) {
        // A reader hands out its entries in batches until one comes back empty.
        const batch = await new Promise<Entry[]>((ok, fail) => reader.readEntries(ok, fail));
        if (batch.length === 0) break;
        for (const child of batch) await walk(child);
      }
    }
  };
  const entries = [...data.items].map((item) => (item as unknown as { webkitGetAsEntry(): Entry | null }).webkitGetAsEntry()).filter((e): e is Entry => e !== null);
  for (const entry of entries) await walk(entry);
  return out;
}

export function pickedFiles(list: FileList | null): { path: string; file: File }[] {
  return [...(list ?? [])].map((file) => ({ path: file.webkitRelativePath || file.name, file }));
}
