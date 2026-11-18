// Importing songs, shared by the song list and Settings: the file pickers, the status line,
// and the import itself, so both screens can add songs without either owning the other.

import { importFiles } from './store.ts';
import { h, pickedFiles } from './ui.ts';

/** The status line, shown by the song list and mirrored into Settings while it is up. */
export const importStatus = h('p', { class: 'notice', role: 'status', hidden: true });

/** The last thing an import reported, so Settings can show it even when opened after the fact. */
let lastImport = '';

/** Another screen (Settings) that wants to show import progress and results. */
let mirror: ((text: string) => void) | null = null;

export function setImportMirror(fn: ((text: string) => void) | null): void {
  mirror = fn;
}

/** A message for the screen that is up: it goes to the status line, not to Settings. */
export function say(text: string): void {
  importStatus.hidden = false;
  importStatus.textContent = text;
}

/** An import's progress or result: the status line, and Settings if it is the one asking. */
function sayImport(text: string): void {
  lastImport = text;
  say(text);
  mirror?.(text);
}

export function quiet(): void {
  importStatus.hidden = true;
  importStatus.textContent = '';
  mirror?.('');
}

/** The last import result, kept apart from the song list's own notices. */
export function lastImportMessage(): string {
  return lastImport;
}

const folderInput = h('input', { type: 'file', hidden: true });
folderInput.setAttribute('webkitdirectory', '');
const filesInput = h('input', { type: 'file', hidden: true, multiple: true, accept: '.zip,.smzip,.sm,.ssc,.ogg,.oga,.mp3,.wav,.png,.jpg,.jpeg,.gif,.bmp' });
// The pickers must be in the document for every browser to open them.
document.body.append(folderInput, filesInput);

export function pickFolder(): void {
  folderInput.click();
}

export function pickFiles(): void {
  filesInput.click();
}

/** What the song list does once an import has changed the songs on disk. */
let afterImport: ((firstAddedId: string | null) => void) | null = null;

/** The song list registers this; without it, an import from Settings leaves the songs to be reloaded on the next visit. */
export function setAfterImport(fn: ((firstAddedId: string | null) => void) | null): void {
  afterImport = fn;
}

export async function importPicked(files: { path: string; file: File }[]): Promise<void> {
  if (files.length === 0) return;
  sayImport('Importing…');
  try {
    const result = await importFiles(files, (done, total, name) => sayImport(`Importing ${done + 1} of ${total}: ${name}`));
    const added = result.added.length - result.replaced;
    const parts = [];
    if (added > 0) parts.push(`${added} song${added === 1 ? '' : 's'} added`);
    if (result.replaced > 0) parts.push(`${result.replaced} replaced`);
    if (result.problems.length > 0) parts.push(result.problems.slice(0, 3).join('; ') + (result.problems.length > 3 ? `; and ${result.problems.length - 3} more` : ''));
    sayImport(parts.join('. ') || 'Nothing was imported.');
    afterImport?.(result.added[0]?.id ?? null);
  } catch (error) {
    sayImport(`Import failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function onPicked(fn: (files: { path: string; file: File }[]) => void): void {
  const change = (input: HTMLInputElement): void => {
    const files = pickedFiles(input.files);
    input.value = ''; // picking the same folder again should fire change again
    fn(files);
  };
  folderInput.addEventListener('change', () => change(folderInput));
  filesInput.addEventListener('change', () => change(filesInput));
}