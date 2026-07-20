export interface Song {
  id: string;
  title: string;
  artist: string;
  album?: string;
  duration: number;
  kbps: number | null;
  albumArtData?: ArrayBuffer;
  albumArtMime?: string;
  fileKey: string;
  addedAt: number;
  fileName: string;
  fileSize: number;
  playCount: number;
  lastPlayedAt: number;
  /** Feature (Lyrics): raw lyrics text, either a plain block or LRC-timed
   *  (`[mm:ss.xx]line`) format — see `lyricsFormat` to tell which. Sourced
   *  from an embedded ID3 USLT frame / Vorbis LYRICS comment, or a sibling
   *  `.lrc` file found next to the audio file at import time. */
  lyrics?: string;
  lyricsFormat?: 'lrc' | 'plain';
  /** Feature (Folder re-scan/auto-sync): the folder (relative to whatever
   *  root was selected) this file was imported from, e.g. "Artist/Album".
   *  Undefined for songs imported before this field existed. Used to safely
   *  scope "this song is missing now" detection on a rescan to only the
   *  folders actually covered by the reselected batch — never assumed for
   *  songs whose folder isn't part of what was just rescanned. */
  importFolder?: string;
  /** Feature (Edit tags): manually-editable metadata beyond title/artist/
   *  album, set via the "Edit tags" track-menu action. Not extracted from
   *  the file at import time (no parser support for these yet) -- purely
   *  user-entered and stored in the song record. */
  genre?: string;
  trackNumber?: number;
  year?: number;
}

export interface Playlist {
  id: string;
  name: string;
  songIds: string[];
  createdAt: number;
}

export interface Preferences {
  accentColor: string;
  /** Feature (Gapless/Crossfade): seconds of overlap between the end of one
   *  track and the start of the next. 0 = off (gapless-only: the next track
   *  is still prefetched ahead of time so there's no IndexedDB-read gap, it
   *  just doesn't overlap in playback). */
  crossfadeSeconds?: number;
  /** Feature (5-band EQ): gain in dB per band, roughly -20..+20. See
   *  lib/eqPresets.ts for the band layout and EQState type. */
  eq?: import('./lib/eqPresets').EQState;
  /** Feature (Sort options): persisted so re-opening the app keeps your
   *  chosen library ordering. */
  sortBy?: SortKey;
  sortDir?: 'asc' | 'desc';
}

export type SortKey = 'title' | 'artist' | 'dateAdded' | 'duration' | 'random';

export interface HistoryEntry {
  id: string;        // `${songId}-${timestamp}`
  songId: string;
  playedAt: number;
}

export type RepeatMode = 'off' | 'all' | 'one';
export type ShuffleMode = 'off' | 'view' | 'library';
// Feature (Browse by Artist/Album): 'artists'/'albums' are the top-level grid
// views (Sidebar nav items); { type: 'artist' }/{ type: 'album' } are the
// drill-down song-list views reached by tapping a card in those grids.
export type AppView = 'library' | 'liked' | 'most-played' | 'stats' | 'queue' | 'artists' | 'albums'
  | { type: 'playlist'; id: string }
  | { type: 'artist'; name: string }
  | { type: 'album'; album: string; artist: string };

// Format support: added Opus (Ogg container, same as .ogg) and AIFF/AIF.
// WMA and APE are deliberately NOT included -- no mainstream browser ships a
// decoder for either, so <audio>/Web Audio simply can't play them back. Real
// support would mean bundling a full transcoder (e.g. ffmpeg.wasm, ~25-30MB)
// just to unlock two formats, which is a much bigger call than a format-list
// change -- flagging this rather than quietly shipping files that import
// but won't play.
export const AUDIO_EXTENSIONS = ['.mp3', '.flac', '.wav', '.ogg', '.opus', '.aac', '.m4a', '.aiff', '.aif'];
// Sapphire blue, matching the app icon -- previously Spotify green
// ('#1DB954'), which is kept as a selectable preset in Settings but is no
// longer the default. Deliberately reuses the exact value of the existing
// "Sapphire" premium preset (see SettingsPanel.tsx's PREMIUM_PRESETS)
// rather than a new hex, so the default is a color that's already
// selectable/tested elsewhere in the app.
export const DEFAULT_ACCENT = '#2C5FCC';
export const ROW_HEIGHT = 56;
// Height of the "Pinned" section header row inserted above pinned songs in
// the Library/Playlist views (Feature: Pin/Unpin). Deliberately shorter than
// ROW_HEIGHT since it's a label, not a song row.
export const PINNED_HEADER_HEIGHT = 32;

// A row rendered by VirtualList in views that support pinned-song grouping
// (Library, Playlist). `displayIndex` is the song's 0-based position within
// the pinned-then-unpinned ordering, used for the row's numbered index label
// -- kept separate from the row's raw position in this array so inserting
// the header doesn't shift the numbers shown to the user.
export type LibraryRow =
  | { kind: 'header'; id: string; label: string }
  | { kind: 'song'; song: Song; displayIndex: number };
