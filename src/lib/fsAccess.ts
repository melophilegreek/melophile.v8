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
  // Feature (instant import): per-file permission checks, same as
  // FSDirectoryHandle below -- both file and directory handles are
  // FileSystemHandle in the real API and share these two methods. Needed
  // because Melophile now stores individual file handles (see
  // getFsHandle/importFiles) instead of copying every song's bytes, so a
  // song's audio has to be re-read from disk at play time, which means
  // re-checking permission at that point rather than once up front at import.
  queryPermission(descriptor: { mode: 'read' }): Promise<'granted' | 'denied' | 'prompt'>;
  requestPermission(descriptor: { mode: 'read' }): Promise<'granted' | 'denied' | 'prompt'>;
}
export interface FSDirectoryHandle {
  readonly kind: 'directory';
  readonly name: string;
  queryPermission(descriptor: { mode: 'read' }): Promise<'granted' | 'denied' | 'prompt'>;
  requestPermission(descriptor: { mode: 'read' }): Promise<'granted' | 'denied' | 'prompt'>;
  entries(): AsyncIterableIterator<[string, FSDirectoryHandle | FSFileHandle]>;
}

/** Opens the native directory picker. Returns null if the person cancels it
 *  (the browser throws an AbortError in that case, which isn't a failure).
 *  Shared by the manual "Import folder"/"Rescan folder" flows (App.tsx,
 *  Onboarding.tsx) and Auto Rescan setup below -- it's the same browser
 *  picker either way, just used for different follow-up purposes. */
export async function pickDirectory(): Promise<FSDirectoryHandle | null> {
  try {
    const picker = (window as unknown as { showDirectoryPicker: (opts?: { mode?: 'read' }) => Promise<FSDirectoryHandle> }).showDirectoryPicker;
    return await picker({ mode: 'read' });
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') return null;
    console.warn('Directory picker failed', e);
    return null;
  }
}

/** @deprecated kept as a name-preserving alias so existing Auto Rescan call
 *  sites don't need to change -- use pickDirectory() directly for new code. */
export const pickAutoRescanDirectory = pickDirectory;

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
// Feature (instant import): a hidden, non-enumerable property carrying the
// live FileSystemFileHandle a File was read from, when it came from the
// picker/handle path below (as opposed to a plain <input webkitdirectory>
// selection, which only ever hands over inert File objects with no way to
// re-open them later). scanner.ts checks for this and, when present, tells
// the database to store the *handle* instead of copying the file's bytes --
// the handle can re-read the same bytes from disk on demand at playback
// time, so import no longer has to pay for a multi-gigabyte copy up front.
const FS_HANDLE_PROP = '__melophileFsHandle';

export function getFsHandle(file: File): FSFileHandle | undefined {
  return (file as unknown as Record<string, unknown>)[FS_HANDLE_PROP] as FSFileHandle | undefined;
}

export async function collectFilesFromHandle(root: FSDirectoryHandle): Promise<File[]> {
  const out: File[] = [];
  async function walk(handle: FSDirectoryHandle, path: string): Promise<void> {
    for await (const [name, entry] of handle.entries()) {
      const entryPath = `${path}/${name}`;
      if (entry.kind === 'directory') {
        await walk(entry as FSDirectoryHandle, entryPath);
      } else {
        try {
          const fileHandle = entry as FSFileHandle;
          const file = await fileHandle.getFile();
          Object.defineProperty(file, 'webkitRelativePath', { value: entryPath, configurable: true });
          Object.defineProperty(file, FS_HANDLE_PROP, { value: fileHandle, configurable: true });
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
