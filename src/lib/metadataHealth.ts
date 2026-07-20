import type { Song } from '../types';
import { splitArtists } from './artistParser';

// Feature (Metadata health check): a scan over the whole library that
// surfaces four common kinds of messy metadata -- missing album art,
// missing year, missing genre, and inconsistently-spelled artist names
// (e.g. "A.R. Rahman" vs "AR Rahman" vs "A R Rahman" showing up as separate
// artists in the Artists grid because they don't string-match exactly) --
// so they can be fixed in one batch pass instead of hunting song by song.

export interface ArtistVariant {
  /** The exact credited name as it appears in one or more songs' Artist tags. */
  name: string;
  /** How many songs carry this exact spelling (post split-credit). */
  count: number;
  songIds: string[];
}

export interface ArtistVariantGroup {
  /** The normalized form shared by every variant in the group (not shown to
   *  the user directly -- just the clustering key). */
  normalized: string;
  variants: ArtistVariant[];
}

export interface MetadataHealthReport {
  missingArt: Song[];
  missingYear: Song[];
  missingGenre: Song[];
  artistVariantGroups: ArtistVariantGroup[];
}

/** Normalizes an artist name for fuzzy-matching purposes: lowercase, periods
 *  and other punctuation stripped, whitespace collapsed. "A.R. Rahman",
 *  "AR Rahman", and "A R Rahman" all normalize to "ar rahman" and cluster
 *  together; genuinely different artists (different letters, not just
 *  different punctuation/spacing) don't. */
export function normalizeArtistName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[.,'’]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/** Runs the full health scan over the library. */
export function scanMetadataHealth(songs: Song[]): MetadataHealthReport {
  const missingArt: Song[] = [];
  const missingYear: Song[] = [];
  const missingGenre: Song[] = [];

  // name -> variant accumulator, keyed by exact spelling
  const byExactName = new Map<string, { count: number; songIds: string[] }>();

  for (const s of songs) {
    if (!s.albumArtData) missingArt.push(s);
    if (s.year == null) missingYear.push(s);
    if (!s.genre?.trim()) missingGenre.push(s);

    for (const name of splitArtists(s.artist)) {
      if (name === 'Unknown Artist') continue; // not a real spelling to flag
      const existing = byExactName.get(name);
      if (existing) { existing.count++; existing.songIds.push(s.id); }
      else byExactName.set(name, { count: 1, songIds: [s.id] });
    }
  }

  // Cluster exact spellings by their normalized form; only keep clusters
  // with 2+ distinct spellings -- a single spelling, however it's written,
  // isn't an inconsistency.
  const byNormalized = new Map<string, ArtistVariant[]>();
  byExactName.forEach((data, name) => {
    const norm = normalizeArtistName(name);
    if (!norm) return;
    const variant: ArtistVariant = { name, count: data.count, songIds: data.songIds };
    const list = byNormalized.get(norm);
    if (list) list.push(variant); else byNormalized.set(norm, [variant]);
  });

  const artistVariantGroups: ArtistVariantGroup[] = [];
  byNormalized.forEach((variants, normalized) => {
    if (variants.length < 2) return;
    variants.sort((a, b) => b.count - a.count); // most common spelling first (good merge default)
    artistVariantGroups.push({ normalized, variants });
  });
  artistVariantGroups.sort((a, b) => b.variants.reduce((n, v) => n + v.count, 0) - a.variants.reduce((n, v) => n + v.count, 0));

  return { missingArt, missingYear, missingGenre, artistVariantGroups };
}

/** Rewrites one credited-name segment of a (possibly slash-joined) raw
 *  Artist tag, leaving every other credited name in the field untouched --
 *  e.g. replaceArtistCredit("Sai Abhyankkar/ Sai Smriti", "Sai Smriti", "Sai
 *  Smrithi") -> "Sai Abhyankkar/ Sai Smrithi". Re-joins with "/ " regardless
 *  of the original spacing around slashes, which also quietly normalizes any
 *  inconsistent "/"-spacing in the field as a side effect. If `oldName`
 *  isn't actually one of the credited segments, the field is returned
 *  unchanged. */
export function replaceArtistCredit(rawArtist: string, oldName: string, newName: string): string {
  const parts = splitArtists(rawArtist);
  if (!parts.includes(oldName)) return rawArtist;
  return parts.map((p) => (p === oldName ? newName : p)).join('/ ');
}
