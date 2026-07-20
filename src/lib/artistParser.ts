import type { Song } from '../types';

// Feature (Split multi-artist credits): Tamil film metadata (and plenty of
// other regional/film metadata) commonly crams composer + every singer on a
// track into one Artist tag, slash-separated -- e.g.
// "Sai Abhyankkar/ Sai Smriti/ Sathyan Ilanko". Stored/displayed as-is
// everywhere else in the app (SongRow, search, Edit Tags, etc.) -- this
// module only powers *browsing/filtering by individual credited artist* (the
// Artists grid + artist detail view), per product decision to leave the raw
// field untouched rather than rewrite anyone's tags.

/** Splits a raw Artist tag into its individual credited names. Handles the
 *  common "/" separator (with or without surrounding whitespace). A field
 *  with no "/" just returns itself as a single-element array, so every
 *  caller can treat every song uniformly instead of special-casing
 *  single-artist songs. Empty/whitespace-only segments (e.g. a stray
 *  trailing "/") are dropped. */
export function splitArtists(raw: string | undefined | null): string[] {
  const trimmed = raw?.trim();
  if (!trimmed) return ['Unknown Artist'];
  const parts = trimmed.split('/').map((p) => p.trim()).filter(Boolean);
  return parts.length > 0 ? parts : ['Unknown Artist'];
}

/** True if `name` is one of the individually-credited artists on `song`
 *  (case-sensitive exact match against each split segment, matching the
 *  case-sensitive equality the rest of the app already uses for artist
 *  identity -- see BrowseGrid's groupByArtist / App's getViewSongs). */
export function songHasArtist(song: Song, name: string): boolean {
  return splitArtists(song.artist).includes(name);
}
