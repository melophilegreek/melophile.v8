import { Music, Users, Disc3 } from 'lucide-react';
import type { Song } from '../types';
import { getArtUrl, useAlbumArtError } from './SongRow';
import { initialFor, placeholderBackground } from '../lib/artPlaceholder';

export interface ArtistGroup { name: string; count: number; sample: Song }
export interface AlbumGroup { album: string; artist: string; count: number; sample: Song }

/** Groups the library into artists, sorted alphabetically (case-insensitive),
 *  each carrying one representative song (used for its art) and a track count. */
export function groupByArtist(songs: Song[]): ArtistGroup[] {
  const map = new Map<string, ArtistGroup>();
  for (const s of songs) {
    const name = s.artist?.trim() || 'Unknown Artist';
    const existing = map.get(name);
    if (existing) { existing.count++; if (!existing.sample.albumArtData && s.albumArtData) existing.sample = s; }
    else map.set(name, { name, count: 1, sample: s });
  }
  return Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
}

/** Groups the library into albums (keyed by album+artist, since two artists
 *  can share an album title). Songs with no album tag are excluded — they
 *  have nothing meaningful to group by and would otherwise all collapse
 *  into one giant fake "album". */
export function groupByAlbum(songs: Song[]): AlbumGroup[] {
  const map = new Map<string, AlbumGroup>();
  for (const s of songs) {
    if (!s.album?.trim()) continue;
    const album = s.album.trim();
    const artist = s.artist?.trim() || 'Unknown Artist';
    const key = `${album}::${artist}`;
    const existing = map.get(key);
    if (existing) { existing.count++; if (!existing.sample.albumArtData && s.albumArtData) existing.sample = s; }
    else map.set(key, { album, artist, count: 1, sample: s });
  }
  return Array.from(map.values()).sort((a, b) => a.album.localeCompare(b.album, undefined, { sensitivity: 'base' }));
}

function Tile({ title, subtitle, sample, accentColor, roundedFull, onClick }: {
  title: string; subtitle: string; sample: Song; accentColor: string; roundedFull?: boolean; onClick: () => void;
}) {
  const artUrl = getArtUrl(sample);
  const { showArt, onError } = useAlbumArtError(sample, artUrl);
  return (
    <button onClick={onClick} className="group flex flex-col items-start text-left gap-2 p-2 rounded-xl hover:bg-white/5 transition-colors">
      <div className={`w-full aspect-square overflow-hidden flex items-center justify-center shadow-lg ${roundedFull ? 'rounded-full' : 'rounded-lg'}`}
        style={{ background: placeholderBackground(accentColor) }}>
        {showArt
          ? <img src={artUrl!} alt="" className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300" onError={onError} />
          : <span className="text-2xl font-bold" style={{ color: accentColor }}>{initialFor(sample)}</span>}
      </div>
      <div className="min-w-0 w-full">
        <p className="text-white text-sm font-semibold truncate">{title}</p>
        <p className="text-white/40 text-xs truncate">{subtitle}</p>
      </div>
    </button>
  );
}

export function ArtistsGrid({ songs, accentColor, onSelect }: {
  songs: Song[]; accentColor: string; onSelect: (name: string) => void;
}) {
  const artists = groupByArtist(songs);
  if (artists.length === 0) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center text-white/25 gap-2">
        <Users size={40} className="mb-2 text-white/15" />
        <p className="font-medium">No artists yet</p>
      </div>
    );
  }
  return (
    <div className="flex-1 overflow-y-auto p-3">
      <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(130px, 1fr))' }}>
        {artists.map((a) => (
          <Tile key={a.name} title={a.name} subtitle={`${a.count} song${a.count !== 1 ? 's' : ''}`}
            sample={a.sample} accentColor={accentColor} roundedFull onClick={() => onSelect(a.name)} />
        ))}
      </div>
    </div>
  );
}

export function AlbumsGrid({ songs, accentColor, onSelect }: {
  songs: Song[]; accentColor: string; onSelect: (album: string, artist: string) => void;
}) {
  const albums = groupByAlbum(songs);
  if (albums.length === 0) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center text-white/25 gap-2">
        <Disc3 size={40} className="mb-2 text-white/15" />
        <p className="font-medium">No albums yet</p>
        <p className="text-xs">Songs need an album tag to show up here</p>
      </div>
    );
  }
  return (
    <div className="flex-1 overflow-y-auto p-3">
      <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(130px, 1fr))' }}>
        {albums.map((a) => (
          <Tile key={`${a.album}::${a.artist}`} title={a.album} subtitle={a.artist}
            sample={a.sample} accentColor={accentColor} onClick={() => onSelect(a.album, a.artist)} />
        ))}
      </div>
    </div>
  );
}

// Small "no results" placeholder shared by both grids when a search query
// filters out everything (kept generic/exported in case it's useful elsewhere).
export function EmptyBrowseState({ label }: { label: string }) {
  return (
    <div className="flex-1 flex flex-col items-center justify-center text-white/25 gap-2">
      <Music size={40} className="mb-2 text-white/15" />
      <p className="font-medium">{label}</p>
    </div>
  );
}
