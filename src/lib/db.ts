import { openDB as idbOpen, type IDBPDatabase } from 'idb';
import type { Song, Playlist, Preferences, HistoryEntry } from '../types';
import { DEFAULT_ACCENT } from '../types';
import type { FSDirectoryHandle } from './fsAccess';
import { EQ_FLAT } from './eqPresets';

interface MelophileDB {
  songs: { key: string; value: Song };
  files: { key: string; value: Blob };
  'liked-songs': { key: string; value: string };
  'pinned-songs': { key: string; value: string };
  playlists: { key: string; value: Playlist };
  preferences: { key: string; value: string };
  history: { key: string; value: HistoryEntry };
}

let _db: IDBPDatabase<MelophileDB> | null = null;

async function getDB(): Promise<IDBPDatabase<MelophileDB>> {
  if (_db) return _db;
  // Bumped 3 -> 4 to add the 'pinned-songs' store (Pin/Unpin feature).
  // Mirrors 'liked-songs' exactly: a store of songId -> songId, so
  // getAllKeys() doubles as both the id list and the membership check.
  _db = await idbOpen<MelophileDB>('melophile', 4, {
    upgrade(db, oldVersion) {
      if (!db.objectStoreNames.contains('songs')) {
        const s = db.createObjectStore('songs', { keyPath: 'id' });
        s.createIndex('addedAt' as never, 'addedAt' as never);
      }
      if (!db.objectStoreNames.contains('files')) db.createObjectStore('files');
      if (!db.objectStoreNames.contains('liked-songs')) db.createObjectStore('liked-songs');
      if (!db.objectStoreNames.contains('playlists')) db.createObjectStore('playlists', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('preferences')) db.createObjectStore('preferences');
      if (oldVersion < 3 && !db.objectStoreNames.contains('history')) {
        const h = db.createObjectStore('history', { keyPath: 'id' });
        h.createIndex('playedAt' as never, 'playedAt' as never);
      }
      if (oldVersion < 4 && !db.objectStoreNames.contains('pinned-songs')) {
        db.createObjectStore('pinned-songs');
      }
    },
  });
  return _db;
}

// ── Songs ─────────────────────────────────────────────────────────────────────
export async function getAllSongs(): Promise<Song[]> {
  const db = await getDB();
  const all = await db.getAll('songs');
  return all.sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }));
}
export async function saveSong(song: Song): Promise<void> { const db = await getDB(); await db.put('songs', song); }

// Performance (folder import): writes many songs + their file blobs in a
// single readwrite transaction instead of one `db.put` transaction per file.
// Each `db.put` shorthand opens and commits its own transaction; for an
// import of hundreds of files, that per-file transaction overhead (not the
// actual byte writes) is what made import slow. Batching amortizes that
// overhead across every song in the batch.
export async function saveSongsBatch(items: { song: Song; file: File }[]): Promise<void> {
  if (items.length === 0) return;
  const db = await getDB();
  const tx = db.transaction(['songs', 'files'], 'readwrite');
  const songsStore = tx.objectStore('songs');
  const filesStore = tx.objectStore('files');
  for (const { song, file } of items) {
    songsStore.put(song);
    filesStore.put(file, song.fileKey);
  }
  await tx.done;
}
export async function updateSongArt(id: string, art?: ArrayBuffer, mime?: string): Promise<void> {
  const db = await getDB(); const s = await db.get('songs', id); if (!s) return;
  await db.put('songs', { ...s, albumArtData: art, albumArtMime: mime });
}
// Feature (Edit tags): persists the manually-editable metadata fields set
// from the "Edit tags" track-menu action. Mirrors updateSongArt's shape --
// read-modify-write on the existing record, no-op if the song is gone.
export async function updateSongTags(id: string, tags: {
  title: string; artist: string; album?: string; genre?: string; trackNumber?: number; year?: number;
}): Promise<void> {
  const db = await getDB(); const s = await db.get('songs', id); if (!s) return;
  await db.put('songs', { ...s, ...tags });
}
// Feature (Metadata health check): applies a per-song partial patch to many
// songs in one readwrite transaction -- used by the health check's batch-fix
// actions (bulk-set year/genre across a selection, and rewriting the Artist
// field across every song touched by an artist-name merge). Mirrors
// saveSongsBatch's "one transaction, not one per song" approach. Songs that
// no longer exist are silently skipped rather than failing the whole batch.
export async function updateSongsBatch(patches: { id: string; patch: Partial<Song> }[]): Promise<void> {
  if (patches.length === 0) return;
  const db = await getDB();
  const tx = db.transaction('songs', 'readwrite');
  const store = tx.objectStore('songs');
  for (const { id, patch } of patches) {
    const existing = await store.get(id);
    if (!existing) continue;
    store.put({ ...existing, ...patch });
  }
  await tx.done;
}
export async function deleteSong(id: string, fileKey: string): Promise<void> {
  const db = await getDB(); const tx = db.transaction(['songs', 'files'], 'readwrite');
  await Promise.all([tx.objectStore('songs').delete(id), tx.objectStore('files').delete(fileKey), tx.done]);
}
// Wipes the entire library: every song record, every stored audio blob, and
// every liked-song flag (a liked id pointing at a deleted song is orphaned
// data, so it's cleared alongside). Playlists themselves are left in place —
// the caller is responsible for emptying/updating their songIds — since
// whether to keep empty playlists around vs. delete them is a product
// decision, not a storage-layer one.
export async function clearAllSongs(): Promise<void> {
  const db = await getDB();
  const tx = db.transaction(['songs', 'files', 'liked-songs', 'pinned-songs'], 'readwrite');
  await Promise.all([
    tx.objectStore('songs').clear(),
    tx.objectStore('files').clear(),
    tx.objectStore('liked-songs').clear(),
    tx.objectStore('pinned-songs').clear(),
    tx.done,
  ]);
}
export async function saveFile(key: string, blob: Blob): Promise<void> { const db = await getDB(); await db.put('files', blob, key); }
export async function getFile(key: string): Promise<Blob | undefined> { const db = await getDB(); return db.get('files', key); }

// ── Liked Songs ───────────────────────────────────────────────────────────────
export async function getLikedIds(): Promise<Set<string>> { const db = await getDB(); const keys = await db.getAllKeys('liked-songs'); return new Set(keys as string[]); }
export async function setLiked(songId: string, liked: boolean): Promise<void> { const db = await getDB(); if (liked) await db.put('liked-songs', songId, songId); else await db.delete('liked-songs', songId); }

// ── Pinned Songs ──────────────────────────────────────────────────────────────
// FIX (pin order): the store's value used to just be the songId itself, so
// the only "order" available on reload was IndexedDB's default
// ascending-by-key sort -- which isn't "first pinned first" at all. The
// value is now the timestamp the song was pinned at, and getPinnedIds sorts
// by that before building the Set, so the Set's iteration order (which
// App.tsx relies on to lay out the Pinned section) reflects actual pin
// order, oldest pin first, and survives a reload.
export async function getPinnedIds(): Promise<Set<string>> {
  const db = await getDB();
  const keys = (await db.getAllKeys('pinned-songs')) as string[];
  const values = (await db.getAll('pinned-songs')) as number[];
  const withOrder = keys.map((key, i) => ({ key, order: values[i] ?? 0 }));
  withOrder.sort((a, b) => a.order - b.order);
  return new Set(withOrder.map((e) => e.key));
}
export async function setPinned(songId: string, pinned: boolean): Promise<void> { const db = await getDB(); if (pinned) await db.put('pinned-songs', Date.now(), songId); else await db.delete('pinned-songs', songId); }

// ── Playlists ─────────────────────────────────────────────────────────────────
export async function getPlaylists(): Promise<Playlist[]> { const db = await getDB(); const all = await db.getAll('playlists'); return all.sort((a, b) => a.createdAt - b.createdAt); }
export async function savePlaylist(p: Playlist): Promise<void> { const db = await getDB(); await db.put('playlists', p); }
export async function deletePlaylist(id: string): Promise<void> { const db = await getDB(); await db.delete('playlists', id); }

// ── Preferences ───────────────────────────────────────────────────────────────
// Each preference field is stored under its own key in the 'preferences'
// store (same pattern the original accentColor-only version used), rather
// than as one combined object — keeps a partial savePreferences() call from
// clobbering fields it wasn't given.
export async function getPreferences(): Promise<Preferences> {
  const db = await getDB();
  const [color, crossfade, eq, sortBy, sortDir] = await Promise.all([
    db.get('preferences', 'accentColor'),
    db.get('preferences', 'crossfadeSeconds'),
    db.get('preferences', 'eq'),
    db.get('preferences', 'sortBy'),
    db.get('preferences', 'sortDir'),
  ]);
  return {
    accentColor: (color as string | undefined) ?? DEFAULT_ACCENT,
    crossfadeSeconds: (crossfade as number | undefined) ?? 0,
    eq: (eq as Preferences['eq'] | undefined) ?? EQ_FLAT,
    sortBy: (sortBy as Preferences['sortBy'] | undefined) ?? 'title',
    sortDir: (sortDir as Preferences['sortDir'] | undefined) ?? 'asc',
  };
}
export async function savePreferences(prefs: Partial<Preferences>): Promise<void> {
  const db = await getDB();
  const entries = Object.entries(prefs) as [string, unknown][];
  await Promise.all(entries.map(([k, v]) => db.put('preferences', v, k)));
}

// ── Auto Rescan directory handle ────────────────────────────────────────────
// Feature (Auto Rescan): stored separately from Preferences (rather than as
// a field on it) since a FileSystemDirectoryHandle isn't a plain
// JSON-shaped value like the rest of Preferences -- it's a structured-clone-
// able browser object, and getPreferences()/savePreferences() above assume
// every field is safe to read/write as plain data. IndexedDB can store and
// retrieve the handle itself just fine via structured clone; only Chromium
// browsers actually produce one (see fsAccess.ts), so this key is simply
// absent everywhere else.
export async function saveAutoRescanHandle(handle: FSDirectoryHandle | null): Promise<void> {
  const db = await getDB();
  if (handle) await db.put('preferences', handle, 'autoRescanDirHandle');
  else await db.delete('preferences', 'autoRescanDirHandle');
}
export async function getAutoRescanHandle(): Promise<FSDirectoryHandle | undefined> {
  const db = await getDB();
  return db.get('preferences', 'autoRescanDirHandle') as Promise<FSDirectoryHandle | undefined>;
}

// ── Library backup / restore (Feature: export/import) ─────────────────────────
// Exports curation data — NOT the audio files themselves (per spec) — so a
// person can restore liked/pinned status, playlists, and play counts after
// clearing IndexedDB or moving to a new device/browser, as long as they
// re-import the same audio files afterward. Songs are matched back up by
// `fileName` + `fileSize` (the same "same file on disk" key the existing
// folder-rescan dedup already uses in scanner.ts), since fileKey/id are
// regenerated fresh on every import and can't be relied on to match across
// separate import runs.
export interface LibraryBackup {
  version: 1;
  exportedAt: number;
  songs: { fileName: string; fileSize: number; liked: boolean; pinned: boolean; playCount: number; lastPlayedAt: number }[];
  playlists: { name: string; createdAt: number; songs: { fileName: string; fileSize: number }[] }[];
  preferences: Preferences;
}

export async function exportLibraryBackup(): Promise<LibraryBackup> {
  const [songs, liked, pinned, playlists, preferences] = await Promise.all([
    getAllSongs(), getLikedIds(), getPinnedIds(), getPlaylists(), getPreferences(),
  ]);
  const byId = new Map(songs.map((s) => [s.id, s] as const));
  return {
    version: 1,
    exportedAt: Date.now(),
    songs: songs.map((s) => ({
      fileName: s.fileName, fileSize: s.fileSize,
      liked: liked.has(s.id), pinned: pinned.has(s.id),
      playCount: s.playCount ?? 0, lastPlayedAt: s.lastPlayedAt ?? 0,
    })),
    playlists: playlists.map((p) => ({
      name: p.name, createdAt: p.createdAt,
      songs: p.songIds.map((id) => byId.get(id)).filter((s): s is Song => !!s).map((s) => ({ fileName: s.fileName, fileSize: s.fileSize })),
    })),
    preferences,
  };
}

/** Re-applies a previously exported backup against whatever's currently in
 *  the library, matching each backup entry to a live song by fileName+size.
 *  Songs that aren't found (not yet re-imported) are simply skipped and
 *  counted, rather than erroring out the whole restore. */
export async function importLibraryBackup(backup: LibraryBackup): Promise<{ matchedSongs: number; unmatchedSongs: number; playlistsCreated: number }> {
  const db = await getDB();
  const liveSongs = await getAllSongs();
  const keyOf = (fileName: string, fileSize: number) => `${fileName}|${fileSize}`;
  const liveByKey = new Map(liveSongs.map((s) => [keyOf(s.fileName, s.fileSize), s] as const));

  let matchedSongs = 0, unmatchedSongs = 0;
  for (const entry of backup.songs) {
    const song = liveByKey.get(keyOf(entry.fileName, entry.fileSize));
    if (!song) { unmatchedSongs++; continue; }
    matchedSongs++;
    await db.put('songs', { ...song, playCount: Math.max(song.playCount ?? 0, entry.playCount), lastPlayedAt: Math.max(song.lastPlayedAt ?? 0, entry.lastPlayedAt) });
    if (entry.liked) await setLiked(song.id, true);
    if (entry.pinned) await setPinned(song.id, true);
  }

  let playlistsCreated = 0;
  const existingPlaylists = await getPlaylists();
  for (const pl of backup.playlists) {
    const songIds = pl.songs.map((s) => liveByKey.get(keyOf(s.fileName, s.fileSize))?.id).filter((id): id is string => !!id);
    if (songIds.length === 0) continue;
    // Merge into an existing playlist of the same name if one exists, rather
    // than creating a duplicate every time a backup is re-imported.
    const existing = existingPlaylists.find((p) => p.name === pl.name);
    if (existing) {
      const merged = Array.from(new Set([...existing.songIds, ...songIds]));
      await savePlaylist({ ...existing, songIds: merged });
    } else {
      await savePlaylist({ id: `pl-${Date.now()}-${Math.random().toString(36).slice(2)}`, name: pl.name, songIds, createdAt: pl.createdAt || Date.now() });
      playlistsCreated++;
    }
  }

  if (backup.preferences) await savePreferences(backup.preferences);

  return { matchedSongs, unmatchedSongs, playlistsCreated };
}

// ── Play Count / History ──────────────────────────────────────────────────────
// TASK 3 (75%-threshold play counting): logging a "recently played" history
// entry and incrementing a song's play count used to happen together, both
// at the moment playback *started*. They're now two separate calls made at
// two separate moments — recordHistoryEntry() still fires on play start (so
// "Recently Played" reflects what you opened), while incrementPlayCount()
// only fires once playback has actually crossed 75% of the track's
// duration (see player.ts's onThresholdReached), so a song only counts
// toward "Top 10 Most Played" once someone has genuinely listened to it.

/** Logs a "recently played" entry. Fires immediately when a song starts playing. */
export async function recordHistoryEntry(songId: string): Promise<void> {
  const db = await getDB();
  const now = Date.now();
  const entry: HistoryEntry = { id: `${songId}-${now}`, songId, playedAt: now };
  await db.put('history', entry);
}

/** Increments a song's play count. Fires once per qualifying (>=75% listened) play. */
export async function incrementPlayCount(songId: string): Promise<void> {
  const db = await getDB();
  const song = await db.get('songs', songId);
  if (!song) return;
  const now = Date.now();
  await db.put('songs', { ...song, playCount: (song.playCount ?? 0) + 1, lastPlayedAt: now });
}

export async function getHistory(limit = 50): Promise<HistoryEntry[]> {
  const db = await getDB();
  const all = await db.getAll('history');
  return all.sort((a, b) => b.playedAt - a.playedAt).slice(0, limit);
}

export async function clearHistory(): Promise<void> {
  const db = await getDB();
  await db.clear('history');
}
