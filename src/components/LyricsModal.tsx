import { useEffect, useMemo, useRef, useState } from 'react';
import { X, Mic2, Upload, Pencil, Trash2, Loader as Loader2 } from 'lucide-react';
import type { Song } from '../types';
import { saveSong } from '../lib/db';
import { isLrcText, detectLyricsFormat, parseLrc } from '../lib/lrc';

interface Props {
  song: Song;
  currentTime: number;
  accentColor: string;
  onClose: () => void;
  /** Feature (tap-to-seek): jump playback to a synced line's timestamp when
   *  it's tapped, same mechanism the player bar's scrub row uses. */
  onSeek: (time: number) => void;
  /** Called after lyrics are saved to IndexedDB, so the parent can patch its
   *  in-memory song list / currently-playing song (mirrors AlbumArtEditModal's
   *  `onUpdated`). */
  onUpdated: (updated: Song) => void;
}

export function LyricsModal({ song, currentTime, accentColor, onClose, onSeek, onUpdated }: Props) {
  const activeRef = useRef<HTMLParagraphElement>(null);
  const scrollAreaRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Kept as local state (rather than reading `song` directly) so a freshly
  // imported/edited set of lyrics renders — and starts time-syncing — the
  // instant it's saved, without waiting on a round trip through the parent.
  const [localSong, setLocalSong] = useState(song);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setLocalSong(song);
    setEditing(false);
    // Intentionally keyed on song.id only: `song` is a new object reference
    // on every parent render (patched song objects are always shallow
    // clones), so depending on it directly would reset local edits/scroll
    // state mid-edit even when it's still the same track.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [song.id]);

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (editing) setEditing(false); else onClose();
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose, editing]);

  // BUG FIX (lyrics sync showing as plain text): this used to trust
  // `localSong.lyricsFormat` alone, which is decided once at import time.
  // Any song whose timestamps weren't recognized then (or that predates
  // this field existing at all) was stuck rendering as a flat block of text
  // -- brackets and all -- forever, even though the same content passes the
  // exact same timestamp check used for manually-pasted lyrics below.
  // Detecting live from the text itself makes every song self-heal the
  // moment it has `[mm:ss.xx]`-style lines, with no re-import needed.
  const isLrc = useMemo(() => isLrcText(localSong.lyrics), [localSong.lyrics]);
  const lrcLines = useMemo(() => (isLrc && localSong.lyrics ? parseLrc(localSong.lyrics) : []), [isLrc, localSong.lyrics]);

  const activeIndex = useMemo(() => {
    if (!isLrc || lrcLines.length === 0) return -1;
    let idx = -1;
    for (let i = 0; i < lrcLines.length; i++) { if (lrcLines[i].time <= currentTime) idx = i; else break; }
    return idx;
  }, [isLrc, lrcLines, currentTime]);

  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [activeIndex]);

  const startEditing = () => { setDraft(localSong.lyrics ?? ''); setEditing(true); };

  const handleFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setDraft(await file.text());
  };

  const persist = async (updated: Song) => {
    setSaving(true);
    try {
      await saveSong(updated);
      setLocalSong(updated);
      onUpdated(updated);
      setEditing(false);
    } finally {
      setSaving(false);
    }
  };

  const handleSave = () => {
    const text = draft.trim();
    if (!text) return;
    persist({ ...localSong, lyrics: text, lyricsFormat: detectLyricsFormat(text) });
  };

  const handleRemove = () => {
    persist({ ...localSong, lyrics: undefined, lyricsFormat: undefined });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center px-4"
      style={{ background: 'rgba(0,0,0,0.75)', backdropFilter: 'blur(8px)' }}
      onMouseDown={(e) => { if (e.currentTarget === e.target) onClose(); }}>
      <div className="w-full max-w-md h-[70vh] rounded-2xl p-5 shadow-2xl animate-slide-up flex flex-col"
        style={{ background: 'rgba(24,24,24,0.97)', backdropFilter: 'blur(20px)', border: '1px solid rgba(255,255,255,0.1)', boxShadow: '0 8px 32px rgba(0,0,0,0.6)' }}>
        <div className="flex items-start justify-between mb-3 shrink-0">
          <div className="min-w-0">
            <h3 className="text-white font-bold text-lg truncate">{localSong.title}</h3>
            <p className="text-white/40 text-xs truncate">{localSong.artist}</p>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            {!editing && localSong.lyrics && (
              <button onClick={startEditing} className="btn-icon w-8 h-8 hover:bg-white/10 rounded-full" title="Edit lyrics">
                <Pencil size={15} className="text-white/60" />
              </button>
            )}
            <button onClick={editing ? () => setEditing(false) : onClose} className="btn-icon w-8 h-8 hover:bg-white/10 rounded-full">
              <X size={18} className="text-white/60" />
            </button>
          </div>
        </div>

        {editing ? (
          <div className="flex-1 min-h-0 flex flex-col gap-3">
            <p className="text-white/40 text-xs leading-relaxed shrink-0">
              Paste lyrics below, or upload a .lrc / .txt file. Lines with timestamps like{' '}
              <span className="text-white/60 font-mono">[00:12.34]</span> sync automatically to playback.
            </p>
            <input ref={fileInputRef} type="file" accept=".lrc,.txt,text/plain" className="hidden" onChange={handleFile} />
            <button onClick={() => fileInputRef.current?.click()}
              className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-white/5 hover:bg-white/10 text-white transition-colors shrink-0">
              <Upload size={15} style={{ color: accentColor }} />
              <span className="text-sm font-medium">Upload .lrc / .txt file</span>
            </button>
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder={'[00:12.34]First line of the song\n[00:16.02]Next line...\n\n...or just paste plain lyrics with no timestamps'}
              className="flex-1 min-h-0 w-full rounded-xl bg-black/30 border border-white/10 text-white/85 text-sm font-mono p-3 resize-none focus:outline-none focus:border-white/25 placeholder:text-white/20"
            />
            <div className="flex items-center gap-2 shrink-0">
              {localSong.lyrics && (
                <button onClick={handleRemove} disabled={saving}
                  className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-red-400/80 hover:bg-red-500/15 hover:text-red-400 transition-colors text-sm font-medium disabled:opacity-40">
                  <Trash2 size={14} /> Remove
                </button>
              )}
              <div className="flex-1" />
              <button onClick={() => setEditing(false)} disabled={saving}
                className="px-4 py-2 rounded-lg text-sm font-medium text-white/50 hover:text-white/70 transition-colors disabled:opacity-40">
                Cancel
              </button>
              <button onClick={handleSave} disabled={saving || !draft.trim()}
                className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-semibold transition-opacity disabled:opacity-40"
                style={{ background: accentColor, color: '#000' }}>
                {saving && <Loader2 size={14} className="animate-spin" />} Save
              </button>
            </div>
          </div>
        ) : !localSong.lyrics ? (
          <div className="flex-1 flex flex-col items-center justify-center text-white/25 gap-3">
            <Mic2 size={36} className="text-white/15" />
            <p className="font-medium">No lyrics found for this song</p>
            <button onClick={startEditing}
              className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold transition-opacity hover:opacity-90"
              style={{ background: `${accentColor}20`, color: accentColor }}>
              <Upload size={14} /> Import lyrics
            </button>
          </div>
        ) : isLrc && lrcLines.length > 0 ? (
          <div ref={scrollAreaRef} className="flex-1 min-h-0 overflow-y-auto -mx-1 px-1 space-y-3 py-8">
            {lrcLines.map((line, i) => (
              <p key={i} ref={i === activeIndex ? activeRef : undefined}
                onClick={() => onSeek(line.time)}
                className="text-center transition-all duration-200 leading-snug cursor-pointer active:opacity-60"
                style={{
                  color: i === activeIndex ? accentColor : 'rgba(255,255,255,0.35)',
                  fontSize: i === activeIndex ? 17 : 15,
                  fontWeight: i === activeIndex ? 700 : 500,
                }}>
                {line.text || '\u00A0'}
              </p>
            ))}
          </div>
        ) : (
          <div className="flex-1 min-h-0 overflow-y-auto -mx-1 px-1">
            <p className="text-white/80 text-sm leading-relaxed whitespace-pre-wrap">{localSong.lyrics}</p>
          </div>
        )}
      </div>
    </div>
  );
}
