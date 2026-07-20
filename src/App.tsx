import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import {
  Search, X, FolderOpen, Loader as Loader2, Heart, Trash2, Menu, Music as MusicIcon, TrendingUp, RefreshCw, Plus,
  ChevronLeft, ArrowUpDown, CheckSquare, ListPlus, FolderPlus, Shuffle,
} from 'lucide-react';

import { Onboarding } from './components/Onboarding';
import { Sidebar } from './components/Sidebar';
import { SongRow, invalidateArt } from './components/SongRow';
import { AlphaScrollBar } from './components/AlphaScrollBar';
import { VirtualList, type VirtualListHandle } from './components/VirtualList';
import { PlayerBar } from './components/PlayerBar';
import { SettingsPanel } from './components/SettingsPanel';
import { AlbumArtEditModal } from './components/AlbumArtEditModal';
import { EditTagsModal } from './components/EditTagsModal';
import { QueuePanel } from './components/QueuePanel';
import { StatsScreen } from './components/StatsScreen';
import { AddSongsModal } from './components/AddSongsModal';
import { ArtistsGrid, AlbumsGrid } from './components/BrowseGrid';
import { LyricsModal } from './components/LyricsModal';

import { usePlayer } from './hooks/usePlayer';
import { player } from './lib/player';
import { EQ_FLAT, type EQBandKey, type EQState } from './lib/eqPresets';
import {
  getAllSongs, getLikedIds, setLiked as dbSetLiked,
  getPinnedIds, setPinned as dbSetPinned,
  getPlaylists, savePlaylist, deletePlaylist as dbDeletePlaylist,
  getPreferences, savePreferences,
  recordHistoryEntry, incrementPlayCount, getHistory, clearHistory,
  deleteSong as dbDeleteSong,
  clearAllSongs,
  exportLibraryBackup, importLibraryBackup, type LibraryBackup,
  saveAutoRescanHandle, getAutoRescanHandle,
} from './lib/db';
import { importFiles, getTitleArtistDuplicateIds, rescanMissingArt, folderOf, type ImportProgress, type ArtRescanProgress } from './lib/scanner';
import {
  supportsFileSystemAccess, pickAutoRescanDirectory, checkReadPermission, requestReadPermission, collectFilesFromHandle,
  type FSDirectoryHandle,
} from './lib/fsAccess';
import { useListeningStats } from './hooks/useListeningStats';
import type { AppView, HistoryEntry, LibraryRow, Playlist, Song, SortKey } from './types';
import { DEFAULT_ACCENT, PINNED_HEADER_HEIGHT, ROW_HEIGHT } from './types';
import { getContrastText } from './lib/color';

const artUrlCache = new Map<string, string>();
function getCachedArtUrl(song: Song | null): string | null {
  if (!song?.albumArtData) return null;
  if (artUrlCache.has(song.id)) return artUrlCache.get(song.id)!;
  const url = URL.createObjectURL(new Blob([song.albumArtData], { type: song.albumArtMime || 'image/jpeg' }));
  artUrlCache.set(song.id, url);
  return url;
}

// Feature (Sort options -- Random): deterministic Fisher-Yates shuffle keyed
// off `seed` so the resulting order stays stable across re-renders (query
// changes, playback ticks, etc.) and only reshuffles when the seed itself
// changes -- i.e. each time the user (re-)picks "Random" in the sort menu.
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function shuffleSeeded<T>(arr: T[], seed: number): T[] {
  const rand = mulberry32(seed);
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// FIX (inconsistent toast dismiss timing): this component used to own its
// own dismiss timer via `useEffect(() => setTimeout(onDone, 3000), [onDone])`.
// `onDone` was passed in as a fresh inline arrow function on every App
// render (`onDone={() => setToast(null)}`), so its identity changed on
// *any* unrelated App re-render (playback progress ticking, listening-stats
// updates, etc.) — not just when a new toast was shown. Every such render
// re-ran the effect, which cancelled the in-flight timer and started a new
// 3000ms one from scratch, so the real dismiss delay depended on how many
// unrelated renders happened to land during that window. The timer is now
// owned by App itself (see `showToast` below) using a ref that isn't tied
// to render identity, so it always fires exactly once at a fixed 1500ms
// and is cancelled/replaced cleanly if a new toast is triggered first. This
// component is now just a dumb, timer-free renderer.
function Toast({ message }: { message: string }) {
  return (
    // FIX (notification hidden behind Player Bar): this offset was last
    // tuned when the mobile Player Bar container was 128px tall
    // (`bottom-36` = 144px gave a 16px gap above it). The bar's mobile
    // height was since bumped to 176px (see the `h-[176px] md:h-[68px]`
    // wrapper around <PlayerBar> below) without updating this, so the
    // toast's 144px offset sat *inside* the bar's 176px again -- the toast
    // rendered underneath/behind the bar and looked like it never showed
    // up. Bumped to clear the current 176px bar with a small gap; desktop's
    // bar is unchanged so its offset is untouched.
    <div className="fixed bottom-[192px] md:bottom-24 left-1/2 -translate-x-1/2 z-50 animate-slide-up"
      style={{ background: 'rgba(30,30,30,0.97)', backdropFilter: 'blur(16px)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 999, padding: '10px 20px', color: 'white', fontSize: 13, boxShadow: '0 8px 32px rgba(0,0,0,0.5)', whiteSpace: 'nowrap' }}>
      {message}
    </div>
  );
}

function NewPlaylistModal({ accentColor, onCreated, onClose }: {
  accentColor: string; onCreated: (name: string) => void; onClose: () => void;
}) {
  const [name, setName] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { inputRef.current?.focus(); }, []);
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(8px)' }}
      onMouseDown={(e) => { if (e.currentTarget === e.target) onClose(); }}>
      <div className="w-80 rounded-2xl p-6 shadow-2xl animate-slide-up"
        style={{ background: 'rgba(28,28,28,0.97)', backdropFilter: 'blur(20px)', border: '1px solid rgba(255,255,255,0.1)', boxShadow: '0 8px 32px rgba(0,0,0,0.6)' }}>
        <h3 className="text-white font-bold text-lg mb-4">New Playlist</h3>
        <input ref={inputRef} type="text" placeholder="Playlist name" value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && name.trim()) { onCreated(name.trim()); onClose(); } }}
          className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-white text-sm placeholder-white/30 focus:outline-none focus:border-white/25 mb-4" />
        <div className="flex gap-2">
          <button onClick={onClose} className="flex-1 py-2.5 rounded-xl bg-white/5 hover:bg-white/10 text-white/70 text-sm transition-colors">Cancel</button>
          <button onClick={() => { if (name.trim()) { onCreated(name.trim()); onClose(); } }} disabled={!name.trim()}
            className="flex-1 py-2.5 rounded-xl font-semibold text-sm transition-all hover:opacity-90 disabled:opacity-40"
            style={{ background: accentColor, color: getContrastText(accentColor) }}>Create</button>
        </div>
      </div>
    </div>
  );
}

// Feature (Playlist delete confirmation): mirrors SongRow.tsx's
// DeleteConfirmDialog exactly (same layout/styling/Escape-to-cancel
// behavior) so deleting a playlist gets the same "are you sure" guard that
// deleting a song already has, instead of the previous single-click
// straight-to-delete button.
// Feature (Bulk multi-select delete + Folder re-scan/auto-sync removal):
// generic confirmation dialog, styled to match DeletePlaylistDialog below.
function ConfirmDialog({ title, message, confirmLabel, onCancel, onConfirm }: {
  title: string; message: string; confirmLabel: string; onCancel: () => void; onConfirm: () => void;
}) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onCancel(); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onCancel]);

  return (
    <div className="fixed inset-0 z-[1100] flex items-center justify-center px-4"
      style={{ background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(8px)' }}
      onMouseDown={(e) => { if (e.currentTarget === e.target) onCancel(); }}>
      <div className="w-full max-w-sm rounded-2xl p-6 shadow-2xl animate-slide-up"
        style={{ background: 'rgba(28,28,28,0.97)', backdropFilter: 'blur(20px)', border: '1px solid rgba(255,255,255,0.1)', boxShadow: '0 8px 32px rgba(0,0,0,0.6)' }}>
        <h3 className="text-white font-bold text-lg mb-2">{title}</h3>
        <p className="text-white/50 text-sm mb-5 leading-snug">{message}</p>
        <div className="flex gap-2">
          <button onClick={onCancel} className="flex-1 py-2.5 rounded-xl bg-white/5 hover:bg-white/10 text-white/70 text-sm transition-colors">Cancel</button>
          <button onClick={onConfirm} className="flex-1 py-2.5 rounded-xl bg-red-500/90 hover:bg-red-500 text-white font-semibold text-sm transition-colors">{confirmLabel}</button>
        </div>
      </div>
    </div>
  );
}

// Feature (Sort options): compact popover, toggles asc/desc when re-clicking
// the already-active key, switches to ascending when picking a new one.
function SortMenu({ sortBy, sortDir, accentColor, onChange }: {
  sortBy: SortKey; sortDir: 'asc' | 'desc'; accentColor: string;
  onChange: (by: SortKey, dir: 'asc' | 'desc') => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    setTimeout(() => document.addEventListener('mousedown', h), 0);
    return () => document.removeEventListener('mousedown', h);
  }, [open]);
  const options: { key: SortKey; label: string }[] = [
    { key: 'title', label: 'Title' }, { key: 'artist', label: 'Artist' },
    { key: 'dateAdded', label: 'Date added' }, { key: 'duration', label: 'Duration' },
    { key: 'random', label: 'Random' },
  ];
  return (
    <div ref={ref} className="relative shrink-0">
      <button onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 text-xs font-medium px-2.5 py-1.5 rounded-full bg-white/5 hover:bg-white/10 transition-colors text-white/60">
        <ArrowUpDown size={12} /> Sort
      </button>
      {open && (
        <div className="absolute top-9 right-0 w-44 rounded-xl overflow-hidden shadow-2xl border border-white/10 z-50 p-1 animate-fade-in"
          style={{ background: 'rgba(30,30,30,0.97)', backdropFilter: 'blur(16px)' }}>
          {options.map((opt) => (
            <button key={opt.key}
              onClick={() => {
                // Random has no ascending/descending direction -- every
                // click (including re-clicking while already active) just
                // asks for a fresh shuffle, handled by onChange bumping a
                // seed whenever 'random' is passed.
                onChange(opt.key, opt.key === 'random' ? 'asc' : (opt.key === sortBy ? (sortDir === 'asc' ? 'desc' : 'asc') : 'asc'));
                setOpen(false);
              }}
              className="w-full flex items-center justify-between px-3 py-2 rounded-lg text-sm hover:bg-white/10 transition-colors"
              style={{ color: sortBy === opt.key ? accentColor : 'rgba(255,255,255,0.75)' }}>
              <span className="flex items-center gap-2">
                {opt.key === 'random' && <Shuffle size={12} />}
                {opt.label}
              </span>
              {sortBy === opt.key && opt.key !== 'random' && <span className="text-xs">{sortDir === 'asc' ? '↑' : '↓'}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// Feature (Bulk multi-select actions in the library)
function BulkActionBar({ count, accentColor, onSelectAll, onClear, onQueue, onLike, onAddToPlaylist, onDelete, onCancel }: {
  count: number; accentColor: string;
  onSelectAll: () => void; onClear: () => void; onQueue: () => void;
  onLike: () => void; onAddToPlaylist: () => void; onDelete: () => void; onCancel: () => void;
}) {
  return (
    <div className="flex items-center gap-2 px-4 py-2 shrink-0" style={{ borderBottom: '1px solid rgba(255,255,255,0.06)', background: `${accentColor}12` }}>
      <button onClick={onCancel} className="btn-icon w-7 h-7 hover:bg-white/10 rounded-lg shrink-0" title="Exit selection">
        <X size={15} className="text-white/60" />
      </button>
      <span className="text-white text-sm font-semibold shrink-0">{count} selected</span>
      <button onClick={onSelectAll} className="text-xs text-white/40 hover:text-white/70 transition-colors shrink-0">Select all</button>
      {count > 0 && <button onClick={onClear} className="text-xs text-white/40 hover:text-white/70 transition-colors shrink-0">Clear</button>}
      <div className="ml-auto flex items-center gap-1 shrink-0">
        <button onClick={onQueue} disabled={count === 0} className="btn-icon w-8 h-8 hover:bg-white/10 rounded-lg disabled:opacity-30" title="Add to queue">
          <ListPlus size={16} className="text-white/60" />
        </button>
        <button onClick={onLike} disabled={count === 0} className="btn-icon w-8 h-8 hover:bg-white/10 rounded-lg disabled:opacity-30" title="Like">
          <Heart size={16} className="text-white/60" />
        </button>
        <button onClick={onAddToPlaylist} disabled={count === 0} className="btn-icon w-8 h-8 hover:bg-white/10 rounded-lg disabled:opacity-30" title="Add to playlist">
          <FolderPlus size={16} className="text-white/60" />
        </button>
        <button onClick={onDelete} disabled={count === 0} className="btn-icon w-8 h-8 hover:bg-red-500/15 rounded-lg disabled:opacity-30" title="Delete">
          <Trash2 size={16} className="text-red-400/70" />
        </button>
      </div>
    </div>
  );
}

function DeletePlaylistDialog({ playlist, onCancel, onConfirm }: {
  playlist: Playlist; onCancel: () => void; onConfirm: () => void;
}) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onCancel(); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onCancel]);

  return (
    <div className="fixed inset-0 z-[1100] flex items-center justify-center px-4"
      style={{ background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(8px)' }}
      onMouseDown={(e) => { if (e.currentTarget === e.target) onCancel(); }}
      onClick={(e) => e.stopPropagation()}>
      <div className="w-full max-w-sm rounded-2xl p-6 shadow-2xl animate-slide-up"
        style={{ background: 'rgba(28,28,28,0.97)', backdropFilter: 'blur(20px)', border: '1px solid rgba(255,255,255,0.1)', boxShadow: '0 8px 32px rgba(0,0,0,0.6)' }}>
        <h3 className="text-white font-bold text-lg mb-2">Delete playlist?</h3>
        <p className="text-white/50 text-sm mb-5 leading-snug">
          <span className="text-white/80 font-medium">{playlist.name}</span> ({playlist.songIds.length} {playlist.songIds.length === 1 ? 'song' : 'songs'}) will be permanently deleted. Your songs themselves won't be removed from your library. This can't be undone.
        </p>
        <div className="flex gap-2">
          <button onClick={onCancel}
            className="flex-1 py-2.5 rounded-xl bg-white/5 hover:bg-white/10 text-white/70 text-sm transition-colors">
            Cancel
          </button>
          <button onClick={onConfirm}
            className="flex-1 py-2.5 rounded-xl bg-red-500/90 hover:bg-red-500 text-white font-semibold text-sm transition-colors">
            Delete
          </button>
        </div>
      </div>
    </div>
  );
}

export default function App() {
  const playerState = usePlayer();
  const listeningStats = useListeningStats();
  const [songs, setSongs] = useState<Song[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [view, setView] = useState<AppView>('library');
  const [likedIds, setLikedIds] = useState<Set<string>>(new Set());
  const [pinnedIds, setPinnedIds] = useState<Set<string>>(new Set());
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const [accentColor, setAccentColor] = useState(DEFAULT_ACCENT);
  const [toast, setToast] = useState<string | null>(null);
  // FIX (inconsistent toast dismiss timing): a single ref-held timer, not
  // tied to any prop/render identity, guarantees a fixed 1500ms dismiss and
  // guarantees only one timer is ever running — a new toast always clears
  // the previous timer first, so overlapping toasts replace cleanly instead
  // of racing.
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showToast = useCallback((message: string, durationMs = 1500) => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    setToast(message);
    toastTimerRef.current = setTimeout(() => {
      setToast(null);
      toastTimerRef.current = null;
    }, durationMs);
  }, []);
  useEffect(() => () => { if (toastTimerRef.current) clearTimeout(toastTimerRef.current); }, []);
  const [importProgress, setImportProgress] = useState<ImportProgress | null>(null);
  // FIX (progress bar "sometimes visible sometimes not"): importProgress
  // flips to non-null and back to null in a single synchronous burst when a
  // scan is fast (few new files, or an art-cache-warm rescan) -- fast enough
  // that the browser never paints a frame in between, so the bar mounts and
  // unmounts without ever actually appearing. `visibleImportProgress` mirrors
  // importProgress but, once shown, stays shown for at least
  // MIN_PROGRESS_VISIBLE_MS -- so a fast scan still gets one clean visible
  // pulse instead of sometimes nothing at all. Slow scans are unaffected
  // (they're already visible far longer than the minimum).
  const MIN_PROGRESS_VISIBLE_MS = 500;
  const [visibleImportProgress, setVisibleImportProgress] = useState<ImportProgress | null>(null);
  const progressShownAt = useRef<number | null>(null);
  const progressHideTimer = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (importProgress) {
      if (progressShownAt.current === null) progressShownAt.current = Date.now();
      if (progressHideTimer.current !== undefined) { clearTimeout(progressHideTimer.current); progressHideTimer.current = undefined; }
      setVisibleImportProgress(importProgress);
    } else if (progressShownAt.current !== null) {
      const remaining = Math.max(0, MIN_PROGRESS_VISIBLE_MS - (Date.now() - progressShownAt.current));
      progressHideTimer.current = window.setTimeout(() => {
        setVisibleImportProgress(null);
        progressShownAt.current = null;
        progressHideTimer.current = undefined;
      }, remaining);
    }
  }, [importProgress]);
  useEffect(() => () => { if (progressHideTimer.current !== undefined) clearTimeout(progressHideTimer.current); }, []);
  const [showSettings, setShowSettings] = useState(false);
  const [showQueueModal, setShowQueueModal] = useState(false);
  const [editSong, setEditSong] = useState<Song | null>(null);
  const [editTagsSong, setEditTagsSong] = useState<Song | null>(null);
  const [showNewPlaylist, setShowNewPlaylist] = useState(false);
  // Feature (Playlist delete confirmation): holds the playlist awaiting a
  // "are you sure?" before it's actually deleted. Set by requestDeletePlaylist
  // (wired to both the sidebar trash icon and the playlist toolbar's "Delete
  // playlist" button); cleared on cancel or after the dialog's own confirm.
  const [deletingPlaylist, setDeletingPlaylist] = useState<Playlist | null>(null);
  const [newPlaylistSong, setNewPlaylistSong] = useState<Song | null>(null);
  // Drives the AddSongsModal picker opened from the playlist detail
  // toolbar's "Add Songs" button (Task 1). A boolean is enough -- the modal
  // only ever targets whichever playlist is currently open (`currentPlaylist`).
  const [showAddSongs, setShowAddSongs] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  // Feature (Sort options)
  const [sortBy, setSortBy] = useState<SortKey>('title');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
  // Feature (Sort options -- Random): bumped every time "Random" is picked
  // (including re-picking it while already active) to force a fresh
  // shuffle -- see shuffleSeeded() and the `filtered` memo below.
  const [randomSeed, setRandomSeed] = useState(1);
  // Feature (Bulk multi-select actions)
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [confirmBulkDelete, setConfirmBulkDelete] = useState(false);
  const [showBulkPlaylistMenu, setShowBulkPlaylistMenu] = useState(false);
  const [showBulkNewPlaylist, setShowBulkNewPlaylist] = useState(false);
  // Feature (Lyrics)
  const [showLyrics, setShowLyrics] = useState(false);
  // Feature (consolidated import menu): the header used to show "Import
  // folder" / "Rescan folder" / "Import files" as three always-visible icon
  // buttons, which crowded the header next to search. They're now collapsed
  // behind a single toggle button; clicking it reveals the same three
  // actions in a small dropdown anchored underneath.
  const [showImportMenu, setShowImportMenu] = useState(false);
  const importMenuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!showImportMenu) return;
    const onDocClick = (e: MouseEvent) => {
      if (importMenuRef.current && !importMenuRef.current.contains(e.target as Node)) setShowImportMenu(false);
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [showImportMenu]);
  const listRef = useRef<VirtualListHandle>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const rescanInputRef = useRef<HTMLInputElement>(null);

  const loadAll = useCallback(async () => {
    const [allSongs, liked, pinned, pls, prefs, hist] = await Promise.all([
      getAllSongs(), getLikedIds(), getPinnedIds(), getPlaylists(), getPreferences(), getHistory(50),
    ]);
    setSongs(allSongs); setLikedIds(liked); setPinnedIds(pinned); setPlaylists(pls);
    setAccentColor(prefs.accentColor); setHistory(hist); setLoading(false);
    setSortBy(prefs.sortBy ?? 'title'); setSortDir(prefs.sortDir ?? 'asc');
    // Feature (Gapless/Crossfade + Basic EQ): the player module is a
    // singleton created at import time, before preferences have loaded from
    // IndexedDB — seed it here once they're available.
    player.setCrossfadeSeconds(prefs.crossfadeSeconds ?? 0);
    player.setEQAll(prefs.eq ?? EQ_FLAT);
  }, []);

  useEffect(() => { loadAll(); }, [loadAll]);

  useEffect(() => { document.documentElement.style.setProperty('--accent-color', accentColor); }, [accentColor]);

  // ── Listening time tracking: accumulate minutes while audio is actually playing ──
  useEffect(() => {
    if (playerState.isPlaying) {
      listeningStats.startSession();
    } else {
      listeningStats.stopSession();
    }
    // Make sure we don't leave a dangling open session if the tab/app closes mid-play.
    return () => { listeningStats.stopSession(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playerState.isPlaying]);

  // ── "Recently Played" history: logged as soon as a song starts playing ──
  useEffect(() => {
    player.onPlayStart = async (song) => {
      await recordHistoryEntry(song.id);
      const entry: HistoryEntry = { id: `${song.id}-${Date.now()}`, songId: song.id, playedAt: Date.now() };
      setHistory((prev) => [entry, ...prev].slice(0, 50));
    };
    return () => { player.onPlayStart = null; };
  }, []);

  // ── Play count tracking (TASK 3): only counts once the listener has
  // actually heard at least 75% of the song, fired by player.ts's
  // onThresholdReached — see that file for the continuous-session guard
  // that stops scrubbing back/forward from double-counting a single listen. ──
  useEffect(() => {
    player.onThresholdReached = async (song) => {
      await incrementPlayCount(song.id);
      // Update local song state so UI (Stats, Library play-count badge,
      // Most Played view) reflects the new count immediately.
      setSongs((prev) => prev.map((s) => s.id === song.id
        ? { ...s, playCount: (s.playCount ?? 0) + 1, lastPlayedAt: Date.now() } : s));
    };
    return () => { player.onThresholdReached = null; };
  }, []);

  const getViewSongs = useCallback((): Song[] => {
    if (view === 'library') return songs;
    if (view === 'liked') return songs.filter((s) => likedIds.has(s.id));
    if (view === 'most-played') {
      return [...songs].filter((s) => (s.playCount ?? 0) > 0).sort((a, b) => (b.playCount ?? 0) - (a.playCount ?? 0)).slice(0, 20);
    }
    if (view === 'queue') return []; // Queue view is handled separately
    if (view === 'stats') return []; // Stats view is handled separately
    // Feature (Browse by Artist/Album): the top-level grids render their own
    // groupings directly from `songs` (see ArtistsGrid/AlbumsGrid), so there's
    // no flat song list for them here; the drill-down detail views below
    // filter to just that artist's/album's tracks.
    if (view === 'artists' || view === 'albums') return [];
    if (typeof view === 'object' && view.type === 'artist') {
      return songs.filter((s) => (s.artist?.trim() || 'Unknown Artist') === view.name);
    }
    if (typeof view === 'object' && view.type === 'album') {
      return songs.filter((s) => s.album?.trim() === view.album && (s.artist?.trim() || 'Unknown Artist') === view.artist);
    }
    if (typeof view === 'object' && view.type === 'playlist') {
      const pl = playlists.find((p) => p.id === view.id);
      if (!pl) return [];
      const idSet = new Set(pl.songIds);
      return songs.filter((s) => idSet.has(s.id));
    }
    return songs;
  }, [view, songs, likedIds, playlists]);

  const viewSongs = useMemo(() => getViewSongs(), [getViewSongs]);

  // Change (duplicate imports): duplicates are always imported now, so this
  // replaces the old import-time "N duplicates found" prompt with a
  // non-blocking signal shown inline per-row instead (see SongRow's
  // `isDuplicateTitleArtist` prop).
  const dupTitleArtistIds = useMemo(() => getTitleArtistDuplicateIds(songs), [songs]);

  const filtered = useMemo(() => {
    const base = !query.trim() ? viewSongs : (() => {
      const q = query.toLowerCase();
      return viewSongs.filter((s) => s.title.toLowerCase().includes(q) || s.artist.toLowerCase().includes(q));
    })();
    // Feature (Sort options): title/asc matches getAllSongs()'s natural
    // IndexedDB ordering already, so skip re-sorting in the (default,
    // common) case — every other combination sorts a copy explicitly.
    if (sortBy === 'title' && sortDir === 'asc') return base;
    // Feature (Sort options -- Random): shuffled separately from the
    // comparator-based sorts below since it has no direction and needs to
    // stay stable across re-renders -- only randomSeed changing should
    // reshuffle it.
    if (sortBy === 'random') return shuffleSeeded(base, randomSeed);
    const cmp: Record<Exclude<SortKey, 'random'>, (a: Song, b: Song) => number> = {
      title: (a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }),
      artist: (a, b) => a.artist.localeCompare(b.artist, undefined, { sensitivity: 'base' }) || a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }),
      dateAdded: (a, b) => a.addedAt - b.addedAt,
      duration: (a, b) => a.duration - b.duration,
    };
    const sorted = [...base].sort(cmp[sortBy]);
    if (sortDir === 'desc') sorted.reverse();
    return sorted;
  }, [viewSongs, query, sortBy, sortDir, randomSeed]);

  // Feature (Pin/Unpin): pinned songs float to the top of the Library and
  // Playlist views specifically (per spec), set off by a "Pinned" section
  // header row -- Liked Songs / Most Played keep their existing ordering
  // (this doesn't touch them; pinning still shows the pin badge there via
  // SongRow's isPinned prop, it just doesn't regroup those two views).
  // `rows` is what VirtualList actually renders (song rows + optional
  // header); `alphaSongs`/`alphaOffset` are the matching inputs for
  // AlphaScrollBar, which needs the same pinned-then-unpinned order plus
  // how many extra rows (the header) sit above the first song.
  const supportsPinnedGrouping = view === 'library' || (typeof view === 'object' && view.type === 'playlist');
  const { rows, alphaSongs, alphaOffset } = useMemo(() => {
    if (!supportsPinnedGrouping || pinnedIds.size === 0) {
      const songRows: LibraryRow[] = filtered.map((song, i) => ({ kind: 'song', song, displayIndex: i }));
      return { rows: songRows, alphaSongs: filtered, alphaOffset: 0 };
    }
    // FIX (pin order): don't derive the pinned list by filtering `filtered`
    // -- that just keeps them in whatever (alphabetical) order they already
    // had. Instead walk `pinnedIds` itself, whose iteration order is pin
    // order (oldest pin first, see db.ts's getPinnedIds/setPinned), and
    // look each song up. That's what makes "first pinned song is first".
    const filteredById = new Map(filtered.map((s) => [s.id, s] as const));
    const pinned = Array.from(pinnedIds)
      .map((id) => filteredById.get(id))
      .filter((s): s is Song => s !== undefined);
    const unpinned = filtered.filter((s) => !pinnedIds.has(s.id));
    const ordered = [...pinned, ...unpinned];
    const songRows: LibraryRow[] = ordered.map((song, i) => ({ kind: 'song', song, displayIndex: i }));
    const rows: LibraryRow[] = pinned.length > 0
      ? [{ kind: 'header', id: '__pinned-header__', label: 'Pinned' }, ...songRows]
      : songRows;
    return { rows, alphaSongs: ordered, alphaOffset: pinned.length > 0 ? 1 : 0 };
  }, [filtered, pinnedIds, supportsPinnedGrouping]);

  useEffect(() => {
    player.setLibrary(songs, viewSongs);
    if (songs.length > 0 && playerState.queue.length === 0) player.initQueue(songs);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [songs]);

  useEffect(() => {
    player.setLibrary(songs, viewSongs);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewSongs]);

  const handlePlay = useCallback(async (song: Song) => { await player.playSong(song, filtered); }, [filtered]);

  const handleLike = useCallback(async (song: Song) => {
    const nowLiked = !likedIds.has(song.id);
    await dbSetLiked(song.id, nowLiked);
    setLikedIds((prev) => { const n = new Set(prev); if (nowLiked) n.add(song.id); else n.delete(song.id); return n; });
    showToast(nowLiked ? `Liked "${song.title}"` : `Removed from Liked Songs`);
  }, [likedIds]);

  // Pin/Unpin (3-dot menu). Mirrors handleLike's persist-then-update-state
  // shape exactly, using the same pattern as the existing Liked Songs
  // toggle -- a dedicated IndexedDB store (see lib/db.ts's 'pinned-songs')
  // plus local Set state. Updating pinnedIds re-derives `rows` below
  // immediately, so the song jumps to/from the Pinned section without a
  // restart.
  const handlePin = useCallback(async (song: Song) => {
    const nowPinned = !pinnedIds.has(song.id);
    await dbSetPinned(song.id, nowPinned);
    setPinnedIds((prev) => { const n = new Set(prev); if (nowPinned) n.add(song.id); else n.delete(song.id); return n; });
    showToast(nowPinned ? `Pinned "${song.title}"` : `Unpinned "${song.title}"`);
  }, [pinnedIds]);

  const handleQueue = useCallback((song: Song) => {
    player.addToQueue(song);
    showToast(`Queued "${song.title}"`);
  }, []);

  const handlePlayFromQueue = useCallback(async (song: Song, index: number) => {
    // BUG FIX (duplicates in queue): removeFromQueue now takes the row's
    // index rather than song.id, so jumping to one copy of a duplicated
    // song only removes that specific queue entry, not every copy of it.
    // (If `index` falls outside the user queue — i.e. this was one of the
    // auto-queued songs after it — removeFromQueue is a no-op, which is
    // correct: those aren't part of the user queue to begin with.)
    player.removeFromQueue(index);
    await player.loadSong(song, true);
    setShowQueueModal(false);
  }, []);

  const handleAddToPlaylist = useCallback(async (song: Song, playlistId: string) => {
    const pl = playlists.find((p) => p.id === playlistId);
    if (!pl || pl.songIds.includes(song.id)) { if (pl) showToast('Already in playlist'); return; }
    const updated = { ...pl, songIds: [...pl.songIds, song.id] };
    await savePlaylist(updated);
    setPlaylists((prev) => prev.map((p) => (p.id === playlistId ? updated : p)));
    showToast(`Added to "${pl.name}"`);
  }, [playlists]);

  // Task 1: bulk-add handler for the new "Add Songs" playlist-toolbar
  // button + AddSongsModal picker. Mirrors handleAddToPlaylist above but
  // takes multiple song ids and performs a single savePlaylist() write
  // instead of one per song -- consistent with the batching approach
  // already used elsewhere in this codebase (see saveSongsBatch in
  // lib/db.ts) to avoid one IndexedDB transaction per item.
  // Data model: persistence reuses the existing Playlist.songIds string[]
  // field and the existing savePlaylist()/IndexedDB 'playlists' store --
  // no new storage layer or dependency was needed since playlist-song
  // membership was already modeled and persisted this way.
  const handleAddSongsToPlaylist = useCallback(async (songIds: string[]) => {
    if (typeof view !== 'object' || view.type !== 'playlist') return;
    const pl = playlists.find((p) => p.id === view.id);
    if (!pl) return;
    // Edge case (duplicates): dedupe against a Set so a song can never
    // appear twice in songIds, even if it was somehow already added
    // (e.g. via the per-song context menu) between opening the picker
    // and confirming the selection.
    const existing = new Set(pl.songIds);
    const toAdd = songIds.filter((id) => !existing.has(id));
    if (toAdd.length === 0) return;
    const updated = { ...pl, songIds: [...pl.songIds, ...toAdd] };
    await savePlaylist(updated);
    setPlaylists((prev) => prev.map((p) => (p.id === pl.id ? updated : p)));
    showToast(`Added ${toAdd.length} song${toAdd.length !== 1 ? 's' : ''} to "${pl.name}"`);
  }, [view, playlists]);

  const handleCreatePlaylist = useCallback(async (name: string, forSong?: Song) => {
    const pl: Playlist = { id: `pl-${Date.now()}-${Math.random().toString(36).slice(2)}`, name, songIds: forSong ? [forSong.id] : [], createdAt: Date.now() };
    await savePlaylist(pl);
    setPlaylists((prev) => [...prev, pl]);
    showToast(`Created "${name}"`);
    return pl;
  }, []);

  const handleDeletePlaylist = useCallback(async (id: string) => {
    await dbDeletePlaylist(id);
    setPlaylists((prev) => prev.filter((p) => p.id !== id));
    if (typeof view === 'object' && view.type === 'playlist' && view.id === id) setView('library');
    showToast('Playlist deleted');
  }, [view]);

  // Feature (Playlist delete confirmation): the trash icon / toolbar button
  // now call this instead of handleDeletePlaylist directly -- it just opens
  // the confirm dialog. The dialog's onConfirm is what actually calls
  // handleDeletePlaylist.
  const requestDeletePlaylist = useCallback((id: string) => {
    const pl = playlists.find((p) => p.id === id);
    if (pl) setDeletingPlaylist(pl);
  }, [playlists]);

  const handleRemoveFromPlaylist = useCallback(async (song: Song) => {
    if (typeof view !== 'object' || view.type !== 'playlist') return;
    const pl = playlists.find((p) => p.id === view.id);
    if (!pl) return;
    const updated = { ...pl, songIds: pl.songIds.filter((id) => id !== song.id) };
    await savePlaylist(updated);
    setPlaylists((prev) => prev.map((p) => (p.id === view.id ? updated : p)));
  }, [view, playlists]);

  const handleDeleteSong = useCallback(async (song: Song) => {
    // Remove from IndexedDB (both the song record and its audio blob).
    await dbDeleteSong(song.id, song.fileKey);

    // Drop any cached album-art object URL so it doesn't leak.
    invalidateArt(song.id);
    artUrlCache.delete(song.id);

    // Update local state immediately so the row disappears without a reload.
    setSongs((prev) => prev.filter((s) => s.id !== song.id));

    if (likedIds.has(song.id)) {
      setLikedIds((prev) => { const n = new Set(prev); n.delete(song.id); return n; });
      await dbSetLiked(song.id, false);
    }
    if (pinnedIds.has(song.id)) {
      setPinnedIds((prev) => { const n = new Set(prev); n.delete(song.id); return n; });
      await dbSetPinned(song.id, false);
    }

    // Edge case: the song may still be referenced by one or more playlists.
    // Those stale ids would otherwise linger in storage forever (they're
    // already invisible in playlist views since we filter by the live
    // `songs` list, but we clean them up so the playlist data stays tidy).
    const affected = playlists.filter((p) => p.songIds.includes(song.id));
    if (affected.length > 0) {
      const updated = affected.map((p) => ({ ...p, songIds: p.songIds.filter((id) => id !== song.id) }));
      await Promise.all(updated.map((p) => savePlaylist(p)));
      setPlaylists((prev) => prev.map((p) => updated.find((u) => u.id === p.id) ?? p));
    }

    // Edge case: the song may be currently playing, queued, or up next —
    // player.removeSong() strips it out and advances playback if needed.
    player.removeSong(song.id);

    showToast(`Deleted "${song.title}"`);
  }, [likedIds, pinnedIds, playlists]);

  // "Delete all songs" (Settings → Danger Zone): mirrors handleDeleteSong's
  // cleanup above but for the whole library at once, instead of looping
  // handleDeleteSong per song (which would fire a separate player.removeSong
  // + toast + playlist save for every track — slow and visually noisy for a
  // library of any real size).
  const handleDeleteAllSongs = useCallback(async () => {
    await clearAllSongs();

    // Drop every cached album-art object URL so none of them leak.
    songs.forEach((s) => { invalidateArt(s.id); artUrlCache.delete(s.id); });

    setSongs([]);
    setLikedIds(new Set());
    setPinnedIds(new Set());

    // Playlists no longer reference any songs, but the playlists themselves
    // (their names) are left intact — same "keep the shell, drop the dead
    // ids" behavior as single-song delete.
    if (playlists.some((p) => p.songIds.length > 0)) {
      const updated = playlists.map((p) => ({ ...p, songIds: [] }));
      await Promise.all(updated.map((p) => savePlaylist(p)));
      setPlaylists(updated);
    }

    player.clearAll();
    showToast('Deleted all songs from your library');
  }, [songs, playlists]);

  // "Fix missing album art" (Settings → Library): re-parses the audio blob
  // already stored for every song, using the same extractMeta() import
  // uses. Covers songs imported before an art-parsing bug fix landed (the
  // UTF-16 description bug, the unsynchronisation bug -- see
  // metadataParser.ts's comments) -- those files never get a second look
  // otherwise, since importing only runs once per file. Deliberately scans
  // every song, not just ones with no art data at all: the UTF-16 bug left
  // `albumArtData` populated with corrupted-but-non-empty bytes, so a
  // "missing art" filter would skip right past exactly the songs that need
  // fixing (see rescanMissingArt's comments in scanner.ts).
  const [artRescan, setArtRescan] = useState<(ArtRescanProgress & { running: boolean }) | null>(null);
  const handleRescanArt = useCallback(async () => {
    setArtRescan({ current: 0, total: 0, found: 0, running: true });
    const result = await rescanMissingArt((p) => setArtRescan({ ...p, running: true }));
    // Re-pull from IndexedDB rather than patching state in place -- simplest
    // way to pick up every song rescanMissingArt touched without threading
    // per-song updates back out of it.
    const allSongs = await getAllSongs();
    songs.forEach((s) => { invalidateArt(s.id); artUrlCache.delete(s.id); });
    setSongs(allSongs);
    setArtRescan(null);
    showToast(result.fixed > 0
      ? `Fixed art for ${result.fixed} of ${result.scanned} song${result.scanned === 1 ? '' : 's'}`
      : result.scanned > 0 ? 'No art issues found' : 'Your library is empty');
  }, [songs]);

  // REMOVED: the playlist-toolbar "Like all" bulk-like button and the
  // library-view "Add all to Liked Songs" bulk-like button (and their
  // handlers) have both been removed per request. Individual per-song like
  // buttons (SongRow's `onLike`/`handleLike`) are untouched.

  const handleImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files?.length) return;
    const fileArr = Array.from(files);

    // Duplicates (by file path) are always imported now -- no prompt, no
    // skipping. Tracks that share a title+artist with an existing track are
    // still surfaced to the user, just as a non-blocking badge in the list
    // (see dupTitleArtistIds below) instead of a confirm() dialog up front.
    setImportProgress({ current: 0, total: fileArr.length, fileName: '' });
    const result = await importFiles(fileArr, setImportProgress);
    setImportProgress(null);
    const allSongs = await getAllSongs();
    setSongs(allSongs);
    // BUG FIX (songs silently missing after import): this used to only ever
    // show `Added ${result.added} songs`, completely ignoring
    // `result.skipped`. Any per-file failure inside importFiles/finalizeOne
    // (a thrown error is caught there, not surfaced) meant a song could
    // just vanish from the import with zero indication -- no toast, no
    // error, nothing visible unless devtools happened to be open reading a
    // console.warn. Onboarding's first-run import screen already surfaced
    // this count; this button (the one used for every import after the
    // first) did not.
    showToast(
      `Added ${result.added} song${result.added !== 1 ? 's' : ''}` +
      (result.skipped > 0 ? `, ${result.skipped} file${result.skipped !== 1 ? 's' : ''} could not be imported` : '')
    );
    e.target.value = '';
  };

  const [rescanning, setRescanning] = useState(false);
  // Feature (Folder re-scan/auto-sync): songs whose folder was covered by
  // the just-reselected batch but whose file is no longer in it -- offered
  // up for removal rather than removed automatically (see the importFolder
  // scoping comment below for why this check is safe to run at all).
  const [removedCandidates, setRemovedCandidates] = useState<Song[] | null>(null);

  // Feature (Auto Rescan): the actual scan-and-import logic, pulled out of
  // the <input webkitdirectory> change handler so it can be driven by *any*
  // File[] source -- the manual picker (below) or a silently-collected
  // File[] from a stored File System Access API directory handle (see
  // runAutoRescan further down). `silent` suppresses the "No new songs
  // found" toast, which would otherwise fire every single time the app
  // auto-rescans and finds nothing new -- expected almost every time,
  // and not something worth interrupting the person for.
  const runRescan = useCallback(async (fileArr0: File[], opts?: { silent?: boolean }) => {
    if (rescanning || fileArr0.length === 0) return;
    const selectedKeys = new Set(fileArr0.map((f) => `${f.name}|${f.size}`));
    // Only folders actually represented in this reselection are eligible for
    // "missing file" detection below -- a song from a folder that simply
    // wasn't part of this particular reselect (e.g. rescanning one album
    // subfolder out of a whole library) must never be flagged as removed.
    const selectedFolders = new Set(fileArr0.map((f) => folderOf(f)));
    const existing = new Set(songs.map((s) => `${s.fileName}|${s.fileSize}`));
    const fileArr = fileArr0.filter((f) => !existing.has(`${f.name}|${f.size}`));
    const skipped = fileArr0.length - fileArr.length;
    const missing = songs.filter((s) =>
      s.importFolder !== undefined && selectedFolders.has(s.importFolder) && !selectedKeys.has(`${s.fileName}|${s.fileSize}`));

    if (fileArr.length === 0) {
      if (!opts?.silent) showToast(`No new songs found (${skipped} already in library)`);
      if (missing.length > 0) setRemovedCandidates(missing);
      return;
    }
    setRescanning(true);
    setImportProgress({ current: 0, total: fileArr.length, fileName: '' });
    try {
      const result = await importFiles(fileArr, setImportProgress);
      const allSongs = await getAllSongs();
      setSongs(allSongs);
      // Success message auto-dismisses after 3s (longer than the default
      // 1.5s toast) so it's easy to read after watching a scan run.
      if (result.added > 0) {
        showToast(`Library updated — ${allSongs.length} song${allSongs.length !== 1 ? 's' : ''} found`, 3000);
      } else if (!opts?.silent) {
        showToast(`No new songs found (${skipped} already in library)`, 3000);
      }
    } finally {
      setImportProgress(null);
      setRescanning(false);
      if (missing.length > 0) setRemovedCandidates(missing);
    }
  }, [songs, rescanning, showToast]);

  // "Rescan folder" (toolbar, refresh icon): re-select the same folder you
  // originally imported and only the files that aren't in the library yet
  // get added -- everything already imported is skipped instead of being
  // duplicated, unlike the plain "Import folder" button above. This picker-
  // based flow always needs a fresh click (browsers won't let JS trigger a
  // file/directory picker without one) -- see runAutoRescan below for the
  // File System Access API path that avoids that for people who opt in.
  const handleRescanFolder = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    const fileArr0 = files?.length ? Array.from(files) : [];
    e.target.value = '';
    if (fileArr0.length > 0) await runRescan(fileArr0);
  };

  // Feature (Auto Rescan): silently re-scans a previously-picked directory
  // handle with zero prompts, as long as read permission is still granted --
  // this is what actually removes the need to tap Rescan every time. Kept
  // as a ref-mirrored callback (see runRescanRef below) so the mount/focus
  // effects that call it don't need to be re-subscribed every time `songs`
  // changes (which is what would otherwise force runRescan -- and therefore
  // this -- to be recreated constantly).
  const [autoRescanHandle, setAutoRescanHandle] = useState<FSDirectoryHandle | null>(null);
  // Drives a small "needs permission" banner: browsers don't guarantee a
  // File System Access API grant survives forever (a full browser restart
  // can reset it back to 'prompt'), and re-requesting it requires an actual
  // user gesture -- so when that happens, this asks once instead of just
  // silently going stale forever.
  const [autoRescanNeedsPermission, setAutoRescanNeedsPermission] = useState(false);
  const runRescanRef = useRef(runRescan);
  useEffect(() => { runRescanRef.current = runRescan; }, [runRescan]);
  // Throttles auto-triggered rescans (app focus/visibility regain can fire
  // repeatedly in a short span) without limiting explicit ones (enabling it
  // in Settings, or resuming after a permission prompt) -- those pass force.
  const AUTO_RESCAN_MIN_INTERVAL_MS = 60_000;
  const lastAutoRescanAt = useRef(0);
  const runAutoRescan = useCallback(async (handle: FSDirectoryHandle, force = false) => {
    if (!force && Date.now() - lastAutoRescanAt.current < AUTO_RESCAN_MIN_INTERVAL_MS) return;
    const perm = await checkReadPermission(handle);
    if (perm !== 'granted') { setAutoRescanNeedsPermission(true); return; }
    setAutoRescanNeedsPermission(false);
    lastAutoRescanAt.current = Date.now();
    try {
      const files = await collectFilesFromHandle(handle);
      await runRescanRef.current(files, { silent: true });
    } catch (e) {
      console.warn('Auto rescan: scan failed', e);
    }
  }, []);

  // Kicks off the first auto-rescan of the session once the initial library
  // load has actually finished (`loading` false) -- not on raw mount, since
  // `songs` is still empty at that point and runRescan would (wrongly) treat
  // every file in the folder as new. `initialAutoRescanDone` makes sure this
  // only ever fires once even though `loading` and `runAutoRescan` are both
  // in the dependency array.
  const initialAutoRescanDone = useRef(false);
  useEffect(() => {
    if (loading || initialAutoRescanDone.current || !supportsFileSystemAccess) return;
    initialAutoRescanDone.current = true;
    (async () => {
      const handle = await getAutoRescanHandle();
      if (handle) {
        setAutoRescanHandle(handle);
        runAutoRescan(handle, true);
      }
    })();
  }, [loading, runAutoRescan]);

  // Re-checks whenever the app regains focus/visibility -- covers "reopened
  // the PWA from the home screen" or "switched back to this tab", which is
  // when new files are actually likely to have shown up, without needing a
  // full page reload to trigger the mount effect above again.
  useEffect(() => {
    if (!autoRescanHandle) return;
    const trigger = () => { if (document.visibilityState === 'visible') runAutoRescan(autoRescanHandle); };
    document.addEventListener('visibilitychange', trigger);
    window.addEventListener('focus', trigger);
    return () => {
      document.removeEventListener('visibilitychange', trigger);
      window.removeEventListener('focus', trigger);
    };
  }, [autoRescanHandle, runAutoRescan]);

  const handleEnableAutoRescan = useCallback(async () => {
    const handle = await pickAutoRescanDirectory();
    if (!handle) return;
    await saveAutoRescanHandle(handle);
    setAutoRescanHandle(handle);
    setAutoRescanNeedsPermission(false);
    showToast('Auto rescan enabled');
    runAutoRescan(handle, true);
  }, [runAutoRescan, showToast]);

  const handleDisableAutoRescan = useCallback(async () => {
    await saveAutoRescanHandle(null);
    setAutoRescanHandle(null);
    setAutoRescanNeedsPermission(false);
    showToast('Auto rescan disabled');
  }, [showToast]);

  const handleResumeAutoRescanPermission = useCallback(async () => {
    if (!autoRescanHandle) return;
    const perm = await requestReadPermission(autoRescanHandle);
    if (perm === 'granted') { setAutoRescanNeedsPermission(false); runAutoRescan(autoRescanHandle, true); }
    else showToast('Permission denied — auto rescan paused');
  }, [autoRescanHandle, runAutoRescan, showToast]);

  const handleConfirmRemoveMissing = useCallback(async () => {
    const toRemove = removedCandidates ?? [];
    setRemovedCandidates(null);
    for (const s of toRemove) await handleDeleteSong(s);
    showToast(`Removed ${toRemove.length} song${toRemove.length !== 1 ? 's' : ''} no longer in that folder`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [removedCandidates]);

  const handleSongUpdated = useCallback((updated: Song) => {
    invalidateArt(updated.id);
    artUrlCache.delete(updated.id);
    setSongs((prev) => prev.map((s) => (s.id === updated.id ? updated : s)));
    player.patchCurrentSong(updated);
  }, []);

  const handleAccentChange = useCallback(async (color: string) => {
    setAccentColor(color);
    await savePreferences({ accentColor: color });
  }, []);

  // Feature (Sort options)
  const handleSortChange = useCallback((by: SortKey, dir: 'asc' | 'desc') => {
    setSortBy(by); setSortDir(dir);
    if (by === 'random') setRandomSeed((s) => s + 1);
    savePreferences({ sortBy: by, sortDir: dir });
  }, []);

  // Feature (Gapless/Crossfade)
  const handleCrossfadeChange = useCallback((seconds: number) => {
    player.setCrossfadeSeconds(seconds);
    savePreferences({ crossfadeSeconds: seconds });
  }, []);

  // Feature (5-band EQ + presets)
  const handleEQChange = useCallback((band: EQBandKey, db: number) => {
    player.setEQBand(band, db);
    savePreferences({ eq: { ...player.state.eq, [band]: db } });
  }, []);
  const handleEQPreset = useCallback((bands: EQState) => {
    player.setEQAll(bands);
    savePreferences({ eq: bands });
  }, []);

  // Feature (Library backup/restore)
  const handleExportBackup = useCallback(async () => {
    const backup = await exportLibraryBackup();
    const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `melophile-backup-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showToast('Backup exported');
  }, []);

  const handleImportBackupFile = useCallback(async (file: File) => {
    const text = await file.text();
    const backup = JSON.parse(text) as LibraryBackup;
    const result = await importLibraryBackup(backup);
    // Refresh everything the import could have touched: liked/pinned status,
    // playlists, preferences (including crossfade/EQ), and play counts.
    const [liked, pinned, pls, prefs, allSongs] = await Promise.all([
      getLikedIds(), getPinnedIds(), getPlaylists(), getPreferences(), getAllSongs(),
    ]);
    setLikedIds(liked); setPinnedIds(pinned); setPlaylists(pls);
    setAccentColor(prefs.accentColor);
    setSortBy(prefs.sortBy ?? 'title'); setSortDir(prefs.sortDir ?? 'asc');
    player.setCrossfadeSeconds(prefs.crossfadeSeconds ?? 0);
    player.setEQAll(prefs.eq ?? EQ_FLAT);
    setSongs(allSongs);
    return result;
  }, []);

  const handleShuffleToggle = useCallback(() => {
    player.setShuffle(playerState.shuffleMode === 'off' ? 'view' : 'off');
  }, [playerState.shuffleMode]);

  const handleClearHistory = useCallback(async () => {
    await clearHistory();
    setHistory([]);
    showToast('History cleared');
  }, []);

  // Feature (Bulk multi-select actions in the library)
  const toggleSelectionMode = useCallback(() => {
    setSelectionMode((v) => !v);
    setSelectedIds(new Set());
  }, []);
  const toggleSongSelected = useCallback((song: Song) => {
    setSelectedIds((prev) => {
      const n = new Set(prev);
      if (n.has(song.id)) n.delete(song.id); else n.add(song.id);
      return n;
    });
  }, []);
  const selectAllVisible = useCallback(() => setSelectedIds(new Set(filtered.map((s) => s.id))), [filtered]);
  const clearSelection = useCallback(() => setSelectedIds(new Set()), []);
  const exitSelectionMode = useCallback(() => { setSelectionMode(false); setSelectedIds(new Set()); }, []);

  const selectedSongs = useMemo(() => filtered.filter((s) => selectedIds.has(s.id)), [filtered, selectedIds]);

  const handleBulkAddToQueue = useCallback(() => {
    selectedSongs.forEach((s) => player.addToQueue(s));
    showToast(`Queued ${selectedSongs.length} song${selectedSongs.length !== 1 ? 's' : ''}`);
    exitSelectionMode();
  }, [selectedSongs, exitSelectionMode]);

  const handleBulkLike = useCallback(async () => {
    const toLike = selectedSongs.filter((s) => !likedIds.has(s.id));
    if (toLike.length === 0) { showToast('Already liked'); exitSelectionMode(); return; }
    for (const s of toLike) await dbSetLiked(s.id, true);
    setLikedIds((prev) => { const n = new Set(prev); toLike.forEach((s) => n.add(s.id)); return n; });
    showToast(`Liked ${toLike.length} song${toLike.length !== 1 ? 's' : ''}`);
    exitSelectionMode();
  }, [selectedSongs, likedIds, exitSelectionMode]);

  const handleBulkAddToPlaylist = useCallback(async (playlistId: string) => {
    const pl = playlists.find((p) => p.id === playlistId);
    if (!pl) return;
    const existing = new Set(pl.songIds);
    const toAdd = selectedSongs.map((s) => s.id).filter((id) => !existing.has(id));
    setShowBulkPlaylistMenu(false);
    if (toAdd.length === 0) { showToast('Already in playlist'); exitSelectionMode(); return; }
    const updated = { ...pl, songIds: [...pl.songIds, ...toAdd] };
    await savePlaylist(updated);
    setPlaylists((prev) => prev.map((p) => (p.id === pl.id ? updated : p)));
    showToast(`Added ${toAdd.length} song${toAdd.length !== 1 ? 's' : ''} to "${pl.name}"`);
    exitSelectionMode();
  }, [playlists, selectedSongs, exitSelectionMode]);

  const handleBulkDelete = useCallback(async () => {
    setConfirmBulkDelete(false);
    const toDelete = selectedSongs;
    for (const s of toDelete) await handleDeleteSong(s);
    showToast(`Deleted ${toDelete.length} song${toDelete.length !== 1 ? 's' : ''}`);
    exitSelectionMode();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedSongs, exitSelectionMode]);

  // Feature (Keyboard shortcuts): Space to play/pause, Left/Right to skip
  // tracks, Up/Down for volume, M to mute, L to like the current song.
  // Ignored while typing in any text field (search box, playlist-name
  // input, hex color field, etc.) so plain letters/space still type normally.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const el = document.activeElement as HTMLElement | null;
      const tag = el?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || el?.isContentEditable) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      switch (e.key) {
        case ' ':
          e.preventDefault();
          player.togglePlay();
          break;
        case 'ArrowRight':
          player.next(false);
          break;
        case 'ArrowLeft':
          player.previous();
          break;
        case 'ArrowUp':
          e.preventDefault();
          player.setVolume(Math.min(1, Math.round((player.state.volume + 0.1) * 100) / 100));
          break;
        case 'ArrowDown':
          e.preventDefault();
          player.setVolume(Math.max(0, Math.round((player.state.volume - 0.1) * 100) / 100));
          break;
        case 'm': case 'M':
          player.setMuted(!player.state.muted);
          break;
        case 'l': case 'L':
          if (player.state.currentSong) handleLike(player.state.currentSong);
          break;
        default:
          return;
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [handleLike]);

  const artUrl = useMemo(() => getCachedArtUrl(playerState.currentSong),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [playerState.currentSong?.id, playerState.currentSong?.albumArtData]);

  const currentPlaylist = typeof view === 'object' && view.type === 'playlist' ? playlists.find((p) => p.id === view.id) : null;
  const viewLabel = view === 'library' ? 'Library'
    : view === 'liked' ? 'Liked Songs'
    : view === 'most-played' ? 'Most Played'
    : view === 'stats' ? 'Stats'
    : view === 'queue' ? 'Queue'
    : view === 'artists' ? 'Artists'
    : view === 'albums' ? 'Albums'
    : (typeof view === 'object' && view.type === 'artist') ? view.name
    : (typeof view === 'object' && view.type === 'album') ? view.album
    : currentPlaylist?.name ?? 'Playlist';

  const isSpecialView = view === 'stats' || view === 'queue' || view === 'artists' || view === 'albums';
  // Feature (Browse by Artist/Album): true for the drill-down detail views
  // reached by tapping a card in the Artists/Albums grid — used to show a
  // back chevron and to skip the sort/select toolbar's title-based A-Z bar.
  const browseBackTarget = typeof view === 'object' && view.type === 'artist' ? 'artists'
    : typeof view === 'object' && view.type === 'album' ? 'albums'
    : null;

  // Build the full upcoming list: manually-queued songs first, then the
  // rest of the playback queue after the current index.
  const upcomingSongs = useMemo(() => {
    const songMap = new Map(songs.map((s) => [s.id, s]));
    const userQ = playerState.userQueue.map((q) => songMap.get(q.id)).filter(Boolean) as Song[];
    const autoQ = playerState.queue
      .slice(playerState.currentIndex + 1)
      .map((q) => songMap.get(q.id))
      .filter(Boolean) as Song[];
    return [...userQ, ...autoQ];
  }, [playerState.userQueue, playerState.queue, playerState.currentIndex, songs]);

  // Songs that came from the manual userQueue (first N items) — these are
  // the only ones that can be removed/reordered via the panel.
  const userQueueLen = playerState.userQueue.length;
  const queuedIds = useMemo(() => new Set(playerState.userQueue.map((s) => s.id)), [playerState.userQueue]);

  if (!loading && songs.length === 0) {
    return (
      <>
        <style>{`:root { --accent-color: ${accentColor}; }`}</style>
        <Onboarding accentColor={accentColor} onComplete={loadAll} />
      </>
    );
  }

  return (
    <>
      <style>{`:root { --accent-color: ${accentColor}; }`}</style>

      <div className="h-full flex flex-col bg-[#121212] overflow-hidden">
        <div className="flex-1 min-h-0 flex overflow-hidden">

          {/* Mobile sidebar overlay */}
          {sidebarOpen && <div className="fixed inset-0 z-40 bg-black/60 md:hidden" onClick={() => setSidebarOpen(false)} />}
          <div className={`fixed md:relative z-50 md:z-auto w-64 h-full md:h-auto shrink-0 transition-transform duration-300 ${sidebarOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0'}`}>
            <Sidebar
              currentView={view}
              onViewChange={(v) => { setView(v); setQuery(''); setSidebarOpen(false); }}
              playlists={playlists}
              likedCount={likedIds.size}
              accentColor={accentColor}
              queueCount={playerState.userQueue.length}
              onCreatePlaylist={() => setShowNewPlaylist(true)}
              onDeletePlaylist={requestDeletePlaylist}
              onOpenSettings={() => setShowSettings(true)}
            />
          </div>

          {/* Main content */}
          <div className="flex-1 min-w-0 flex flex-col overflow-hidden">
            {/* Header */}
            <div className="flex items-center gap-2 px-3 md:px-4 pt-3 pb-2 shrink-0" style={{ borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
              <button className="md:hidden btn-icon w-9 h-9 hover:bg-white/8 shrink-0" onClick={() => setSidebarOpen(true)}>
                <Menu size={20} className="text-white/60" />
              </button>
              {browseBackTarget && (
                <button className="btn-icon w-8 h-8 hover:bg-white/8 shrink-0" onClick={() => setView(browseBackTarget)} title="Back">
                  <ChevronLeft size={19} className="text-white/50" />
                </button>
              )}
              <h2 className="text-white font-bold text-base md:text-lg truncate shrink-0 mr-1">{viewLabel}</h2>
              {!isSpecialView && (
                <div className="flex-1 relative max-w-xs ml-auto">
                  <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-white/30" />
                  <input type="text" placeholder="Search…" value={query} onChange={(e) => setQuery(e.target.value)}
                    className="w-full rounded-full pl-8 pr-8 py-2 text-sm text-white placeholder-white/30 focus:outline-none transition-colors"
                    style={{ background: 'rgba(255,255,255,0.07)', border: '1px solid rgba(255,255,255,0.09)' }}
                    onFocus={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.1)'; e.currentTarget.style.borderColor = 'rgba(255,255,255,0.18)'; }}
                    onBlur={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.07)'; e.currentTarget.style.borderColor = 'rgba(255,255,255,0.09)'; }} />
                  {query && <button onClick={() => setQuery('')} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-white/30 hover:text-white/60"><X size={13} /></button>}
                </div>
              )}
              <div className={`${isSpecialView ? 'ml-auto' : ''} flex items-center gap-1 relative`} ref={importMenuRef}>
                {/* Feature (consolidated import menu): single toggle button
                    replaces the three always-visible icon buttons below. */}
                <button
                  className={`btn-icon w-9 h-9 shrink-0 ${showImportMenu ? 'bg-white/10' : 'hover:bg-white/8'}`}
                  title="Import songs"
                  aria-label="Import songs"
                  aria-expanded={showImportMenu}
                  onClick={() => setShowImportMenu(v => !v)}>
                  {rescanning ? <Loader2 size={17} className="text-white/50 animate-spin" /> : <FolderOpen size={17} className="text-white/50" />}
                </button>
                {/* Inline scan status, next to the toggle button (Task 2) */}
                {rescanning && visibleImportProgress && (
                  <span className="hidden sm:inline text-white/50 text-xs whitespace-nowrap animate-fade-in">
                    Scanning… {visibleImportProgress.current} / {visibleImportProgress.total} found
                  </span>
                )}
                {showImportMenu && (
                  <div className="absolute top-full right-0 mt-2 w-52 rounded-xl overflow-hidden shadow-2xl border border-white/10 z-50 animate-fade-in"
                    style={{ background: 'rgba(30,30,30,0.97)', backdropFilter: 'blur(16px)' }}>
                    <div className="p-1">
                      {/* Folder import */}
                      <label className="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-white/80 hover:bg-white/10 text-sm transition-colors cursor-pointer"
                        onClick={() => setShowImportMenu(false)}>
                        <FolderOpen size={15} className="text-white/50 shrink-0" /> Import folder
                        <input type="file" ref={folderInputRef}
                          // @ts-expect-error — webkitdirectory is non-standard but widely supported
                          webkitdirectory="" directory="" multiple accept="audio/*" className="hidden" onChange={handleImport} />
                      </label>
                      {/* Rescan folder: re-pick the same folder, only new files get added.
                          Disabled while a scan is already running (Task 2) so a second
                          scan can't be started on top of the first. */}
                      <label
                        className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-white/80 text-sm transition-colors ${rescanning ? 'opacity-40 pointer-events-none cursor-not-allowed' : 'hover:bg-white/10 cursor-pointer'}`}
                        aria-disabled={rescanning}
                        onClick={() => setShowImportMenu(false)}>
                        {rescanning ? <Loader2 size={15} className="text-white/50 animate-spin shrink-0" /> : <RefreshCw size={15} className="text-white/50 shrink-0" />}
                        {rescanning ? 'Scanning…' : 'Rescan library'}
                        <input type="file" ref={rescanInputRef} disabled={rescanning}
                          // @ts-expect-error — webkitdirectory is non-standard but widely supported
                          webkitdirectory="" directory="" multiple accept="audio/*" className="hidden" onChange={handleRescanFolder} />
                      </label>
                      {/* Individual file import */}
                      <label className="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-white/80 hover:bg-white/10 text-sm transition-colors cursor-pointer"
                        onClick={() => setShowImportMenu(false)}>
                        <MusicIcon size={15} className="text-white/50 shrink-0" /> Import files
                        <input type="file" ref={fileInputRef} multiple accept="audio/*" className="hidden" onChange={handleImport} />
                      </label>
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* Import / rescan progress.
                FIX (rescan progress not visible): this bar already covered
                the Rescan Folder button (it shares importProgress state with
                regular import), but at 2px tall with no percentage readout
                it was easy to miss entirely, especially on a fast scan or on
                a phone where the inline "Scanning… N found" text next to the
                button is hidden (`hidden sm:inline`, no room for it there).
                Bumped to a proper 6px bar with a percentage, and worded
                specifically as "Scanning" (not "Importing") while it's the
                rescan flow driving it. */}
            {visibleImportProgress && (
              <div className="px-4 py-2.5 shrink-0" style={{ borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
                <div className="flex items-center justify-between gap-2 text-white/60 text-xs mb-1.5">
                  <span className="flex items-center gap-2 min-w-0">
                    <Loader2 size={12} className="animate-spin shrink-0" style={{ color: accentColor }} />
                    <span className="truncate">
                      {visibleImportProgress.finalizing
                        ? `Saving ${visibleImportProgress.current} / ${visibleImportProgress.total}…`
                        : rescanning
                          ? `Scanning folder… ${visibleImportProgress.current} / ${visibleImportProgress.total}`
                          : visibleImportProgress.fileName ? `Importing ${visibleImportProgress.current} / ${visibleImportProgress.total} — ${visibleImportProgress.fileName}` : `Importing ${visibleImportProgress.current} / ${visibleImportProgress.total}…`}
                    </span>
                  </span>
                  <span className="tabular-nums shrink-0">{Math.round((visibleImportProgress.current / Math.max(visibleImportProgress.total, 1)) * 100)}%</span>
                </div>
                <div className="h-1 bg-white/10 rounded-full overflow-hidden">
                  <div className="h-full rounded-full transition-all" style={{ width: `${(visibleImportProgress.current / Math.max(visibleImportProgress.total, 1)) * 100}%`, background: accentColor }} />
                </div>
              </div>
            )}

            {/* Feature (Auto Rescan): browsers don't guarantee a File System
                Access API permission grant survives forever (a full browser
                restart can reset it to 'prompt'), and re-granting needs an
                actual tap -- this banner is that one tap, shown only when
                it's actually needed instead of on every app open. */}
            {autoRescanNeedsPermission && (
              <div className="px-4 py-2 flex items-center justify-between gap-3 shrink-0"
                style={{ background: `${accentColor}12`, borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
                <span className="flex items-center gap-2 text-white/70 text-xs min-w-0">
                  <FolderOpen size={13} className="shrink-0" style={{ color: accentColor }} />
                  <span className="truncate">Auto rescan needs permission to keep watching your folder.</span>
                </span>
                <button onClick={handleResumeAutoRescanPermission}
                  className="text-xs font-semibold px-3 py-1 rounded-full shrink-0 transition-opacity hover:opacity-90"
                  style={{ background: accentColor, color: getContrastText(accentColor) }}>
                  Resume
                </button>
              </div>
            )}

            {/* ── STATS VIEW ── */}
            {view === 'stats' ? (
              <StatsScreen songs={songs} history={history} accentColor={accentColor} onClearHistory={handleClearHistory} onPlaySong={handlePlay} listeningStats={listeningStats.stats} sessions={listeningStats.sessions} />
            ) : view === 'queue' ? (
              /* ── QUEUE VIEW ── */
              <QueuePanel
                queue={upcomingSongs}
                userQueueLen={userQueueLen}
                currentSong={playerState.currentSong}
                accentColor={accentColor}
                onClose={() => setView('library')}
                onPlayFromQueue={handlePlayFromQueue}
                onRemoveFromQueue={(index) => player.removeFromQueue(index)}
                onReorderQueue={(from, to) => player.reorderQueue(from, to)}
                onClearQueue={() => { player.clearQueue(); showToast('Queue cleared'); }}
                onQueueSong={handleQueue}
              />
            ) : view === 'artists' ? (
              /* ── ARTISTS GRID (Feature: Browse by Artist/Album) ── */
              <ArtistsGrid songs={songs} accentColor={accentColor} onSelect={(name) => setView({ type: 'artist', name })} />
            ) : view === 'albums' ? (
              /* ── ALBUMS GRID (Feature: Browse by Artist/Album) ── */
              <AlbumsGrid songs={songs} accentColor={accentColor} onSelect={(album, artist) => setView({ type: 'album', album, artist })} />
            ) : (
              /* ── SONG LIST VIEWS ── */
              <>
                {/* Playlist toolbar */}
                {currentPlaylist && !selectionMode && (
                  <div className="flex items-center gap-2 px-4 py-2 shrink-0" style={{ borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
                    {/* Task 1: opens the AddSongsModal picker, scoped to
                        whichever playlist is currently open. Replaces the
                        old "Like all" bulk button in this same toolbar slot
                        (Task 2 removed it). */}
                    <button onClick={() => setShowAddSongs(true)}
                      className="flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-full bg-white/5 hover:bg-white/10 transition-colors" style={{ color: accentColor }}>
                      <Plus size={13} style={{ color: accentColor }} /> Add Songs
                    </button>
                    <button onClick={() => requestDeletePlaylist(currentPlaylist.id)}
                      className="flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-full bg-white/5 hover:bg-red-500/15 hover:text-red-400 text-white/50 transition-colors">
                      <Trash2 size={13} /> Delete playlist
                    </button>
                    <span className="text-white/30 text-xs ml-auto">{filtered.length} songs</span>
                    <button onClick={toggleSelectionMode} className="btn-icon w-7 h-7 hover:bg-white/10 rounded-lg shrink-0" title="Select songs">
                      <CheckSquare size={14} className="text-white/40" />
                    </button>
                    <SortMenu sortBy={sortBy} sortDir={sortDir} accentColor={accentColor} onChange={handleSortChange} />
                  </div>
                )}

                {/* Most played header */}
                {view === 'most-played' && !selectionMode && (
                  <div className="px-4 py-2 shrink-0 flex items-center gap-2" style={{ borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
                    <TrendingUp size={14} style={{ color: accentColor }} />
                    <span className="text-white/40 text-xs">Top 20 songs by play count</span>
                    <span className="text-white/30 text-xs ml-auto">{filtered.length} songs</span>
                    <button onClick={toggleSelectionMode} className="btn-icon w-7 h-7 hover:bg-white/10 rounded-lg shrink-0" title="Select songs">
                      <CheckSquare size={14} className="text-white/40" />
                    </button>
                  </div>
                )}

                {/* Song count (+ bulk action, Library view only) */}
                {!currentPlaylist && view !== 'most-played' && !selectionMode && (
                  <div className="px-4 py-1.5 shrink-0 flex items-center gap-2">
                    <span className="text-white/25 text-xs">{filtered.length}{filtered.length !== viewSongs.length ? ` of ${viewSongs.length}` : ''} songs</span>
                    <button onClick={toggleSelectionMode} className="btn-icon w-7 h-7 hover:bg-white/10 rounded-lg shrink-0 ml-auto" title="Select songs">
                      <CheckSquare size={14} className="text-white/40" />
                    </button>
                    <SortMenu sortBy={sortBy} sortDir={sortDir} accentColor={accentColor} onChange={handleSortChange} />
                  </div>
                )}

                {/* Feature (Bulk multi-select actions): replaces whichever
                    toolbar row above would normally be showing. */}
                {selectionMode && (
                  <BulkActionBar
                    count={selectedIds.size}
                    accentColor={accentColor}
                    onSelectAll={selectAllVisible}
                    onClear={clearSelection}
                    onQueue={handleBulkAddToQueue}
                    onLike={handleBulkLike}
                    onAddToPlaylist={() => setShowBulkPlaylistMenu(true)}
                    onDelete={() => setConfirmBulkDelete(true)}
                    onCancel={exitSelectionMode}
                  />
                )}

                {/* Song list + A-Z bar */}
                <div className="flex-1 min-h-0 flex overflow-hidden">
                  {loading ? (
                    <div className="flex-1 flex items-center justify-center"><Loader2 size={28} className="animate-spin text-white/20" /></div>
                  ) : filtered.length === 0 ? (
                    <div className="flex-1 flex flex-col items-center justify-center text-white/25 gap-2">
                      {view === 'liked' ? (
                        <><Heart size={40} className="mb-2 text-white/15" /><p className="font-medium">No liked songs yet</p><p className="text-xs">Press the heart icon on any song</p></>
                      ) : view === 'most-played' ? (
                        <><TrendingUp size={40} className="mb-2 text-white/15" /><p className="font-medium">No plays yet</p><p className="text-xs">Play some music to build your stats</p></>
                      ) : (
                        <><FolderOpen size={40} className="mb-2 text-white/15" /><p className="font-medium">No songs found</p></>
                      )}
                    </div>
                  ) : (
                    <>
                      <VirtualList ref={listRef} items={rows} className="flex-1"
                        getItemHeight={(row) => row.kind === 'header' ? PINNED_HEADER_HEIGHT : ROW_HEIGHT}
                        renderItem={(row) => row.kind === 'header' ? (
                          <div key={row.id} className="h-full flex items-end px-3 pb-1.5 text-[11px] font-semibold uppercase tracking-wider text-white/35"
                            style={{ borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
                            {row.label}
                          </div>
                        ) : (
                          <SongRow key={row.song.id} song={row.song} index={row.displayIndex}
                            isCurrent={playerState.currentSong?.id === row.song.id}
                            isPlaying={playerState.isPlaying}
                            isLiked={likedIds.has(row.song.id)}
                            isPinned={pinnedIds.has(row.song.id)}
                            isQueued={queuedIds.has(row.song.id)}
                            accentColor={accentColor}
                            playlists={playlists}
                            isInPlaylist={!!currentPlaylist}
                            showPlayCount={view === 'most-played'}
                            isDuplicateTitleArtist={dupTitleArtistIds.has(row.song.id)}
                            onPlay={handlePlay}
                            onLike={handleLike}
                            onPin={handlePin}
                            onQueue={handleQueue}
                            onAddToPlaylist={handleAddToPlaylist}
                            onCreatePlaylist={(s) => { setNewPlaylistSong(s); setShowNewPlaylist(true); }}
                            onEditArt={setEditSong}
                            onEditTags={setEditTagsSong}
                            onDelete={handleDeleteSong}
                            onRemoveFromPlaylist={currentPlaylist ? handleRemoveFromPlaylist : undefined}
                            onViewQueue={() => setShowQueueModal(true)}
                            selectionMode={selectionMode}
                            isSelected={selectedIds.has(row.song.id)}
                            onToggleSelect={toggleSongSelected}
                          />
                        )} />
                      {/* Feature (Liked Songs A-Z index): previously excluded
                          `view === 'liked'` -- Liked Songs is already sorted
                          alphabetically (it's filtered straight out of the
                          globally alphabetical `songs` array), so the same
                          jump-to-letter bar now applies there too. */}
                      {!query && view !== 'most-played' && <AlphaScrollBar songs={alphaSongs} accentColor={accentColor} listRef={listRef} indexOffset={alphaOffset} />}
                    </>
                  )}
                </div>
              </>
            )}
          </div>
        </div>

        {/* Player Bar */}
        {/* Mobile now uses a taller 3-row expanded layout (art+title / transport
            controls / seek row), so it needs more vertical room than desktop's
            compact single-row 68px bar. */}
        <div className="h-[176px] md:h-[68px] shrink-0 px-2 pb-2">
          <PlayerBar
            currentSong={playerState.currentSong}
            artUrl={artUrl}
            isPlaying={playerState.isPlaying}
            isLoading={playerState.isLoading}
            currentTime={playerState.currentTime}
            duration={playerState.duration}
            volume={playerState.volume}
            muted={playerState.muted}
            shuffleMode={playerState.shuffleMode}
            accentColor={accentColor}
            queueCount={playerState.userQueue.length}
            onPrev={() => player.previous()}
            onNext={() => player.next(false)}
            onTogglePlay={() => player.togglePlay()}
            onSeek={(t) => player.seek(t)}
            onVolume={(v) => player.setVolume(v)}
            onMute={() => player.setMuted(!playerState.muted)}
            onShuffleToggle={handleShuffleToggle}
            onShuffleModeChange={(mode) => player.setShuffle(mode)}
            onOpenQueue={() => setShowQueueModal(true)}
            hasLyrics={!!playerState.currentSong?.lyrics}
            onOpenLyrics={() => setShowLyrics(true)}
            sleepTimerEndsAt={playerState.sleepTimerEndsAt}
            sleepTimerEndOfTrack={playerState.sleepTimerEndOfTrack}
            onSetSleepTimer={(m) => player.setSleepTimer(m)}
          />
        </div>
      </div>

      {/* Modals */}
      {showSettings && (
        <SettingsPanel
          accentColor={accentColor}
          onAccentChange={handleAccentChange}
          onClose={() => setShowSettings(false)}
          songCount={songs.length}
          onDeleteAllSongs={handleDeleteAllSongs}
          onRescanArt={handleRescanArt}
          artRescan={artRescan}
          crossfadeSeconds={playerState.crossfadeSeconds}
          onCrossfadeChange={handleCrossfadeChange}
          eq={playerState.eq}
          onEQChange={handleEQChange}
          onEQPreset={handleEQPreset}
          onExportBackup={handleExportBackup}
          onImportBackupFile={handleImportBackupFile}
          autoRescanSupported={supportsFileSystemAccess}
          autoRescanEnabled={!!autoRescanHandle}
          autoRescanFolderName={autoRescanHandle?.name}
          onEnableAutoRescan={handleEnableAutoRescan}
          onDisableAutoRescan={handleDisableAutoRescan}
        />
      )}
      {editSong && <AlbumArtEditModal song={editSong} accentColor={accentColor} onClose={() => setEditSong(null)} onUpdated={(u) => { handleSongUpdated(u); setEditSong(null); }} />}
      {editTagsSong && <EditTagsModal song={editTagsSong} accentColor={accentColor} onClose={() => setEditTagsSong(null)} onUpdated={(u) => { handleSongUpdated(u); setEditTagsSong(null); }} />}
      {showNewPlaylist && <NewPlaylistModal accentColor={accentColor} onCreated={(name) => handleCreatePlaylist(name, newPlaylistSong ?? undefined)} onClose={() => { setShowNewPlaylist(false); setNewPlaylistSong(null); }} />}
      {/* Task 1: song picker for the playlist toolbar's "Add Songs" button.
          Only rendered while a playlist is actually open, so `currentPlaylist`
          is guaranteed non-null here. */}
      {showAddSongs && currentPlaylist && (
        <AddSongsModal
          playlist={currentPlaylist}
          songs={songs}
          accentColor={accentColor}
          onClose={() => setShowAddSongs(false)}
          onConfirm={handleAddSongsToPlaylist}
        />
      )}
      {deletingPlaylist && (
        <DeletePlaylistDialog
          playlist={deletingPlaylist}
          onCancel={() => setDeletingPlaylist(null)}
          onConfirm={() => { handleDeletePlaylist(deletingPlaylist.id); setDeletingPlaylist(null); }}
        />
      )}

      {/* Feature (Bulk multi-select): delete confirmation */}
      {confirmBulkDelete && (
        <ConfirmDialog
          title={`Delete ${selectedSongs.length} song${selectedSongs.length !== 1 ? 's' : ''}?`}
          message="They'll be removed from your library and any playlists they're in. This can't be undone."
          confirmLabel="Delete"
          onCancel={() => setConfirmBulkDelete(false)}
          onConfirm={handleBulkDelete}
        />
      )}

      {/* Feature (Folder re-scan/auto-sync): removed-file confirmation */}
      {removedCandidates && removedCandidates.length > 0 && (
        <ConfirmDialog
          title={`${removedCandidates.length} song${removedCandidates.length !== 1 ? 's' : ''} no longer found`}
          message={`These files aren't in the folder you just selected anymore. Remove them from your library too? Your other songs won't be affected.`}
          confirmLabel="Remove"
          onCancel={() => setRemovedCandidates(null)}
          onConfirm={handleConfirmRemoveMissing}
        />
      )}

      {/* Feature (Bulk multi-select): "add to playlist" picker */}
      {showBulkPlaylistMenu && (
        <div className="fixed inset-0 z-50 flex items-center justify-center px-4"
          style={{ background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)' }}
          onMouseDown={(e) => { if (e.currentTarget === e.target) setShowBulkPlaylistMenu(false); }}>
          <div className="w-full max-w-xs rounded-2xl p-4 shadow-2xl animate-slide-up"
            style={{ background: 'rgba(24,24,24,0.97)', backdropFilter: 'blur(20px)', border: '1px solid rgba(255,255,255,0.1)' }}>
            <h3 className="text-white font-semibold text-sm mb-3">
              Add {selectedIds.size} song{selectedIds.size !== 1 ? 's' : ''} to playlist
            </h3>
            <div className="max-h-60 overflow-y-auto space-y-1 mb-2">
              {playlists.length === 0 && <p className="text-white/30 text-xs py-2">No playlists yet</p>}
              {playlists.map((pl) => (
                <button key={pl.id} onClick={() => handleBulkAddToPlaylist(pl.id)}
                  className="w-full text-left px-3 py-2 rounded-lg text-sm text-white/80 hover:bg-white/10 transition-colors truncate flex items-center justify-between gap-2">
                  <span className="truncate">{pl.name}</span>
                  <span className="text-white/30 text-xs shrink-0">{pl.songIds.length}</span>
                </button>
              ))}
            </div>
            <button onClick={() => { setShowBulkPlaylistMenu(false); setShowBulkNewPlaylist(true); }}
              className="w-full flex items-center justify-center gap-1.5 py-2 rounded-lg text-sm font-medium transition-colors hover:opacity-90"
              style={{ background: `${accentColor}20`, color: accentColor }}>
              <Plus size={14} /> New playlist
            </button>
            <button onClick={() => setShowBulkPlaylistMenu(false)} className="w-full mt-2 py-2 rounded-lg text-sm text-white/40 hover:text-white/60 transition-colors">
              Cancel
            </button>
          </div>
        </div>
      )}
      {showBulkNewPlaylist && (
        <NewPlaylistModal
          accentColor={accentColor}
          onClose={() => setShowBulkNewPlaylist(false)}
          onCreated={async (name) => {
            const pl = await handleCreatePlaylist(name);
            const updated = { ...pl, songIds: selectedSongs.map((s) => s.id) };
            await savePlaylist(updated);
            setPlaylists((prev) => prev.map((p) => (p.id === pl.id ? updated : p)));
            showToast(`Created "${name}" with ${selectedSongs.length} song${selectedSongs.length !== 1 ? 's' : ''}`);
            setShowBulkNewPlaylist(false);
            exitSelectionMode();
          }}
        />
      )}

      {/* Feature (Lyrics) */}
      {showLyrics && playerState.currentSong && (
        <LyricsModal
          song={playerState.currentSong}
          currentTime={playerState.currentTime}
          accentColor={accentColor}
          onClose={() => setShowLyrics(false)}
          onSeek={(t) => player.seek(t)}
          onUpdated={handleSongUpdated}
        />
      )}
      {showQueueModal && (
        <div className="fixed inset-0 z-50 flex justify-end md:items-center md:justify-center"
          style={{ background: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(4px)' }}
          onMouseDown={(e) => { if (e.target === e.currentTarget) setShowQueueModal(false); }}>
          <div className="w-full max-w-sm h-full md:h-auto md:max-h-[80vh] animate-slide-in-right md:animate-slide-up"
            style={{ background: 'rgba(20,20,20,0.97)', backdropFilter: 'blur(20px)', borderLeft: '1px solid rgba(255,255,255,0.1)', maxWidth: '480px' }}>
            <QueuePanel
              queue={upcomingSongs}
              userQueueLen={userQueueLen}
              currentSong={playerState.currentSong}
              accentColor={accentColor}
              onClose={() => setShowQueueModal(false)}
              onPlayFromQueue={handlePlayFromQueue}
              onRemoveFromQueue={(index) => player.removeFromQueue(index)}
              onReorderQueue={(from, to) => player.reorderQueue(from, to)}
              onClearQueue={() => { player.clearQueue(); showToast('Queue cleared'); }}
              onQueueSong={handleQueue}
            />
          </div>
        </div>
      )}
      {toast && <Toast message={toast} />}
    </>
  );
}
