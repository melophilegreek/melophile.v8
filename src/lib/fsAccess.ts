// Feature (Auto Rescan): the existing "Rescan folder" button uses
// <input webkitdirectory>, which the browser will not let JS trigger
// without a fresh user click every single time -- there's no way to make
// that silent. The File System Access API (Chromium browsers only --
// Chrome/Edge on desktop and Android; not Safari, not Firefox) is
// different: `showDirectoryPicker()` returns a handle that can be stored
// (IndexedDB can structured-clone it) and re-used later. Once read
// permission has been granted, the app can re-open that same handle and
// walk it again with zero prompts -- which is what makes a genuinely
// automatic "rescan on every app open" possible, as opposed to just a
// reminder to click the button.
//
// Everything in this file is a no-op-safe wrapper: every export checks
// `supportsFileSystemAccess` (or is only ever called after checking it),
// so the rest of the app can call these without its own try/catch for
// "this API doesn't exist here".

export const supportsFileSystemAccess =
  typeof window !== 'undefined' && typeof (window as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker === 'function';

// Minimal hand-rolled typing for the handful of File System Access API
// members this app actually calls. Not every TS lib target ships full
// coverage for this API yet, and it's only implemented by Chromium
// browsers at runtime regardless -- so rather than depend on lib.dom.d.ts
// having it, these are just enough structural types to describe what we
// use, checked against the real runtime objects via supportsFileSystemAccess.
export interface FSFileHandle {
  readonly kind: 'file';
  readonly name: string;
  getFile(): Promise<File>;
}
export interface FSDirectoryHandle {
  readonly kind: 'directory';
  readonly name: string;
  queryPermission(descriptor: { mode: 'read' }): Promise<'granted' | 'denied' | 'prompt'>;
  requestPermission(descriptor: { mode: 'read' }): Promise<'granted' | 'denied' | 'prompt'>;
  entries(): AsyncIterableIterator<[string, FSDirectoryHandle | FSFileHandle]>;
}

/** Opens the native directory picker. Returns null if the person cancels it
 *  (the browser throws an AbortError in that case, which isn't a failure). */
export async function pickAutoRescanDirectory(): Promise<FSDirectoryHandle | null> {
  try {
    const picker = (window as unknown as { showDirectoryPicker: (opts?: { mode?: 'read' }) => Promise<FSDirectoryHandle> }).showDirectoryPicker;
    return await picker({ mode: 'read' });
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') return null;
    console.warn('Auto rescan: directory picker failed', e);
    return null;
  }
}

/** Checks current permission without prompting -- safe to call silently
 *  (e.g. on app load) since it never shows UI. */
export async function checkReadPermission(handle: FSDirectoryHandle): Promise<'granted' | 'denied' | 'prompt'> {
  try { return await handle.queryPermission({ mode: 'read' }); }
  catch (e) { console.warn('Auto rescan: permission check failed', e); return 'denied'; }
}

/** Prompts for permission if needed. Only resolves to 'granted' from a real
 *  browser prompt, so this must be called from a user gesture (a click/tap
 *  handler) -- browsers silently ignore the prompt otherwise. */
export async function requestReadPermission(handle: FSDirectoryHandle): Promise<'granted' | 'denied' | 'prompt'> {
  try { return await handle.requestPermission({ mode: 'read' }); }
  catch (e) { console.warn('Auto rescan: permission request failed', e); return 'denied'; }
}

/** Recursively walks a directory handle into a flat File[], with each
 *  File's `webkitRelativePath` set to match what <input webkitdirectory>
 *  would have produced (rooted at the picked folder's own name) -- so
 *  folderOf() and everything downstream in scanner.ts (folder cover art,
 *  .lrc sidecar matching, import-folder scoping for missing-file detection)
 *  keeps working completely unmodified. */
export async function collectFilesFromHandle(root: FSDirectoryHandle): Promise<File[]> {
  const out: File[] = [];
  async function walk(handle: FSDirectoryHandle, path: string): Promise<void> {
    for await (const [name, entry] of handle.entries()) {
      const entryPath = `${path}/${name}`;
      if (entry.kind === 'directory') {
        await walk(entry as FSDirectoryHandle, entryPath);
      } else {
        try {
          const file = await (entry as FSFileHandle).getFile();
          Object.defineProperty(file, 'webkitRelativePath', { value: entryPath, configurable: true });
          out.push(file);
        } catch (e) {
          console.warn('Auto rescan: could not read file', entryPath, e);
        }
      }
    }
  }
  await walk(root, root.name);
  return out;
}
