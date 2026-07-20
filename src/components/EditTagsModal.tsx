import { useEffect, useRef, useState } from 'react';
import { X, RotateCcw, Loader2 } from 'lucide-react';
import type { Song } from '../types';
import { updateSongTags, getFile } from '../lib/db';
import { extractMeta } from '../lib/metadataParser';

interface Props {
  song: Song;
  accentColor: string;
  onClose: () => void;
  onUpdated: (updated: Song) => void;
}

// "Default" here means the file's true original tag data -- read fresh off
// the actual stored audio file (via extractMeta, the same parser import
// uses), NOT "whatever is currently saved". Editing tags in this modal only
// ever touches the DB record, never the file bytes, so the file's real
// title/artist/album are always still there to re-read, no matter how many
// times the DB record has been edited/saved since import. Falls back the
// same way scanner.ts does at import time if a field truly isn't in the
// file's tags. Album/genre/track/year beyond that have no such fallback
// since they're either optional or never parsed, so "default" for those is
// just empty/unset.
async function readOriginalTags(song: Song) {
  const blob = await getFile(song.fileKey);
  const fallback = {
    title: song.fileName.replace(/\.[^/.]+$/, ''),
    artist: 'Unknown Artist',
    album: '',
    genre: '',
    trackNumber: '',
    year: '',
  };
  if (!blob) return fallback; // file missing from storage -- best-effort fallback
  const file = new File([blob], song.fileName);
  const meta = await extractMeta(file);
  return {
    title: meta.title || fallback.title,
    artist: meta.artist || fallback.artist,
    album: meta.album || '',
    genre: '',
    trackNumber: '',
    year: '',
  };
}

// ── Edit Tags modal ─────────────────────────────────────────────────────────
// Reached from the track's 3-dot menu ("Edit tags"). Lets the user correct
// title/artist/album and set genre/track number/year -- all stored on the
// song record only (no file-tag rewrite; see `updateSongTags`).
export function EditTagsModal({ song, accentColor, onClose, onUpdated }: Props) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const firstFieldRef = useRef<HTMLInputElement>(null);

  const [title, setTitle] = useState(song.title);
  const [artist, setArtist] = useState(song.artist);
  const [album, setAlbum] = useState(song.album ?? '');
  const [genre, setGenre] = useState(song.genre ?? '');
  const [trackNumber, setTrackNumber] = useState(song.trackNumber != null ? String(song.trackNumber) : '');
  const [year, setYear] = useState(song.year != null ? String(song.year) : '');
  const [saving, setSaving] = useState(false);
  const [resetting, setResetting] = useState(false);

  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', h);
    firstFieldRef.current?.focus();
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);

  const canSave = title.trim().length > 0 && artist.trim().length > 0 && !saving;

  const handleReset = async () => {
    if (resetting) return;
    setResetting(true);
    try {
      const d = await readOriginalTags(song);
      setTitle(d.title); setArtist(d.artist); setAlbum(d.album);
      setGenre(d.genre); setTrackNumber(d.trackNumber); setYear(d.year);
    } finally {
      setResetting(false);
    }
  };

  const handleSave = async () => {
    if (!canSave) return;
    setSaving(true);
    const tags = {
      title: title.trim(),
      artist: artist.trim(),
      album: album.trim() || undefined,
      genre: genre.trim() || undefined,
      trackNumber: trackNumber.trim() ? Number(trackNumber.trim()) : undefined,
      year: year.trim() ? Number(year.trim()) : undefined,
    };
    await updateSongTags(song.id, tags);
    onUpdated({ ...song, ...tags });
    onClose();
  };

  const fieldClass = 'w-full px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-white text-sm placeholder:text-white/25 focus:outline-none focus:border-white/30 transition-colors';
  const labelClass = 'block text-white/40 text-[11px] font-semibold uppercase tracking-wider mb-1.5';

  return (
    <div ref={overlayRef} className="fixed inset-0 z-50 flex items-center justify-center px-4"
      style={{ background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(8px)' }}
      onMouseDown={(e) => { if (e.target === overlayRef.current) onClose(); }}>
      <div className="w-full max-w-sm rounded-2xl p-5 shadow-2xl animate-slide-up"
        style={{ background: 'rgba(28,28,28,0.97)', backdropFilter: 'blur(20px)', border: '1px solid rgba(255,255,255,0.1)', boxShadow: '0 8px 32px rgba(0,0,0,0.6)' }}>
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-white font-bold">Edit Tags</h3>
          <button onClick={onClose} className="btn-icon w-7 h-7 hover:bg-white/10 rounded-full flex items-center justify-center">
            <X size={16} className="text-white/50" />
          </button>
        </div>

        <div className="space-y-3">
          <div>
            <label className={labelClass}>Title</label>
            <input ref={firstFieldRef} className={fieldClass} value={title}
              onChange={(e) => setTitle(e.target.value)} placeholder="Song title" />
          </div>
          <div>
            <label className={labelClass}>Artist</label>
            <input className={fieldClass} value={artist}
              onChange={(e) => setArtist(e.target.value)} placeholder="Artist" />
          </div>
          <div>
            <label className={labelClass}>Album</label>
            <input className={fieldClass} value={album}
              onChange={(e) => setAlbum(e.target.value)} placeholder="Album" />
          </div>
          <div>
            <label className={labelClass}>Genre</label>
            <input className={fieldClass} value={genre}
              onChange={(e) => setGenre(e.target.value)} placeholder="Genre" />
          </div>
          <div className="flex gap-3">
            <div className="flex-1">
              <label className={labelClass}>Track #</label>
              <input className={fieldClass} value={trackNumber} inputMode="numeric"
                onChange={(e) => setTrackNumber(e.target.value.replace(/[^0-9]/g, ''))} placeholder="—" />
            </div>
            <div className="flex-1">
              <label className={labelClass}>Year</label>
              <input className={fieldClass} value={year} inputMode="numeric"
                onChange={(e) => setYear(e.target.value.replace(/[^0-9]/g, ''))} placeholder="—" />
            </div>
          </div>
        </div>

        <button onClick={handleReset} disabled={resetting}
          className="flex items-center gap-1.5 text-white/40 hover:text-white/70 text-xs mt-4 transition-colors disabled:opacity-50">
          {resetting ? <Loader2 size={12} className="animate-spin" /> : <RotateCcw size={12} />}
          {resetting ? 'Reading original tags…' : 'Reset'}
        </button>

        <div className="flex gap-2 mt-3">
          <button onClick={onClose}
            className="flex-1 py-2.5 rounded-xl bg-white/5 hover:bg-white/10 text-white/70 text-sm transition-colors">
            Cancel
          </button>
          <button onClick={handleSave} disabled={!canSave}
            className="flex-1 py-2.5 rounded-xl text-white font-semibold text-sm transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            style={{ background: accentColor }}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}
