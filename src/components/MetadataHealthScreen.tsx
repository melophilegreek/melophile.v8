import { useEffect, useMemo, useState } from 'react';
import { ChevronLeft, ImageOff, CalendarOff, Tag, Users2, Check, Copy, Pencil, Sparkles } from 'lucide-react';
import type { Song } from '../types';
import { scanMetadataHealth, replaceArtistCredit, type ArtistVariantGroup } from '../lib/metadataHealth';
import { getContrastText } from '../lib/color';

interface Props {
  songs: Song[];
  accentColor: string;
  onClose: () => void;
  /** Applies a batch of per-song partial patches (year/genre bulk-fill, or an
   *  artist-name merge rewriting the Artist field) -- persists to IndexedDB
   *  and updates local song state; the screen re-renders off the same
   *  `songs` prop once the parent's state updates. */
  onBatchPatch: (patches: { id: string; patch: Partial<Song> }[]) => Promise<void>;
  /** Opens the existing "Edit Album Art" modal for one song. */
  onEditArt: (song: Song) => void;
}

type Section = 'art' | 'year' | 'genre' | 'artists';

function SummaryCard({ icon, label, count, accentColor, active, onClick }: {
  icon: React.ReactNode; label: string; count: number; accentColor: string; active: boolean; onClick: () => void;
}) {
  return (
    <button onClick={onClick}
      className="flex-1 min-w-[120px] text-left rounded-2xl p-4 transition-colors"
      style={active
        ? { background: `${accentColor}18`, border: `1px solid ${accentColor}50` }
        : { background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.06)' }}>
      <span style={{ color: active ? accentColor : 'rgba(255,255,255,0.5)' }}>{icon}</span>
      <p className="text-2xl font-extrabold text-white mt-2 tabular-nums">{count}</p>
      <p className="text-white/40 text-xs mt-0.5">{label}</p>
    </button>
  );
}

function SongMiniRow({ song, right }: { song: Song; right?: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3 py-2 px-1 -mx-1 rounded-lg hover:bg-white/[0.04] transition-colors">
      <div className="flex-1 min-w-0">
        <p className="text-sm text-white/90 truncate">{song.title}</p>
        <p className="text-xs text-white/40 truncate">{song.artist}{song.album ? ` · ${song.album}` : ''}</p>
      </div>
      {right}
    </div>
  );
}

export function MetadataHealthScreen({ songs, accentColor, onClose, onBatchPatch, onEditArt }: Props) {
  const [section, setSection] = useState<Section>('art');
  const [selectedYearIds, setSelectedYearIds] = useState<Set<string>>(new Set());
  const [selectedGenreIds, setSelectedGenreIds] = useState<Set<string>>(new Set());
  const [yearValue, setYearValue] = useState('');
  const [genreValue, setGenreValue] = useState('');
  const [applying, setApplying] = useState(false);

  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);

  const report = useMemo(() => scanMetadataHealth(songs), [songs]);

  // Missing-art songs grouped by album, so a song that shares an album with
  // one that *does* have art can be batch-fixed with one click ("Copy art to
  // N songs") instead of uploading the same cover N times by hand.
  const artCopyGroups = useMemo(() => {
    const groups = new Map<string, { source: Song; targets: Song[] }>();
    for (const s of report.missingArt) {
      if (!s.album?.trim()) continue;
      const key = `${s.album.trim()}::${s.artist?.trim() ?? ''}`;
      if (groups.has(key)) { groups.get(key)!.targets.push(s); continue; }
      const donor = songs.find((o) => o.id !== s.id && o.albumArtData
        && o.album?.trim() === s.album!.trim() && (o.artist?.trim() ?? '') === (s.artist?.trim() ?? ''));
      if (donor) groups.set(key, { source: donor, targets: [s] });
    }
    return Array.from(groups.values());
  }, [report.missingArt, songs]);
  const artCopyTargetIds = useMemo(() => new Set(artCopyGroups.flatMap((g) => g.targets.map((t) => t.id))), [artCopyGroups]);

  useEffect(() => { setSelectedYearIds(new Set()); setYearValue(''); }, [songs.length]);
  useEffect(() => { setSelectedGenreIds(new Set()); setGenreValue(''); }, [songs.length]);

  const handleCopyArt = async (source: Song, targets: Song[]) => {
    const art = source.albumArtData;
    if (!art) return;
    setApplying(true);
    try {
      await onBatchPatch(targets.map((t) => ({ id: t.id, patch: { albumArtData: art, albumArtMime: source.albumArtMime } })));
    } finally { setApplying(false); }
  };

  const applyYear = async () => {
    const n = Number(yearValue.trim());
    if (!yearValue.trim() || !Number.isFinite(n) || selectedYearIds.size === 0) return;
    setApplying(true);
    try {
      await onBatchPatch(Array.from(selectedYearIds).map((id) => ({ id, patch: { year: n } })));
      setSelectedYearIds(new Set());
      setYearValue('');
    } finally { setApplying(false); }
  };

  const applyGenre = async () => {
    if (!genreValue.trim() || selectedGenreIds.size === 0) return;
    setApplying(true);
    try {
      await onBatchPatch(Array.from(selectedGenreIds).map((id) => ({ id, patch: { genre: genreValue.trim() } })));
      setSelectedGenreIds(new Set());
      setGenreValue('');
    } finally { setApplying(false); }
  };

  const mergeGroup = async (group: ArtistVariantGroup, canonical: string) => {
    const patches: { id: string; patch: Partial<Song> }[] = [];
    const bySongId = new Map(songs.map((s) => [s.id, s] as const));
    for (const variant of group.variants) {
      if (variant.name === canonical) continue;
      for (const songId of variant.songIds) {
        const song = bySongId.get(songId);
        if (!song) continue;
        const newArtist = replaceArtistCredit(song.artist, variant.name, canonical);
        if (newArtist !== song.artist) patches.push({ id: songId, patch: { artist: newArtist } });
      }
    }
    if (patches.length === 0) return;
    setApplying(true);
    try { await onBatchPatch(patches); } finally { setApplying(false); }
  };

  const toggle = (set: Set<string>, setSet: (s: Set<string>) => void, id: string) => {
    const n = new Set(set);
    if (n.has(id)) n.delete(id); else n.add(id);
    setSet(n);
  };

  const tabs: { key: Section; icon: React.ReactNode; label: string; count: number }[] = [
    { key: 'art', icon: <ImageOff size={18} />, label: 'Missing art', count: report.missingArt.length },
    { key: 'year', icon: <CalendarOff size={18} />, label: 'Missing year', count: report.missingYear.length },
    { key: 'genre', icon: <Tag size={18} />, label: 'Missing genre', count: report.missingGenre.length },
    { key: 'artists', icon: <Users2 size={18} />, label: 'Inconsistent names', count: report.artistVariantGroups.length },
  ];

  const allClean = songs.length > 0 && tabs.every((t) => t.count === 0);

  return (
    <div className="fixed inset-0 z-[60] flex flex-col animate-fade-in" style={{ background: '#0a0a0a' }}>
      <div className="flex items-center gap-3 px-4 pt-4 pb-3 shrink-0">
        <button onClick={onClose} className="btn-icon w-9 h-9 hover:bg-white/10 rounded-full -ml-1.5">
          <ChevronLeft size={22} className="text-white" />
        </button>
        <h2 className="text-white font-bold text-lg">Metadata Health</h2>
      </div>

      <div className="flex-1 overflow-y-auto px-4 pb-10">
        {allClean ? (
          <div className="flex flex-col items-center justify-center text-center py-20 text-white/40 gap-3">
            <Sparkles size={40} style={{ color: accentColor }} />
            <p className="font-semibold text-white/70">Your library's metadata looks clean.</p>
            <p className="text-xs max-w-xs">No missing art, years, genres, or artist-name inconsistencies found.</p>
          </div>
        ) : (
          <>
            <p className="text-white/30 text-xs mb-3">Tap a category to review and batch-fix it.</p>
            <div className="flex flex-wrap gap-2 mb-5">
              {tabs.map((t) => (
                <SummaryCard key={t.key} icon={t.icon} label={t.label} count={t.count} accentColor={accentColor}
                  active={section === t.key} onClick={() => setSection(t.key)} />
              ))}
            </div>

            <div className="rounded-2xl p-4" style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.06)' }}>
              {/* ── Missing art ── */}
              {section === 'art' && (
                report.missingArt.length === 0 ? <Empty text="Every song has album art." /> : (
                  <div>
                    {artCopyGroups.length > 0 && (
                      <div className="mb-4 space-y-2">
                        <h4 className="text-white/50 text-[11px] font-semibold uppercase tracking-wider">Quick fixes — same album already has art</h4>
                        {artCopyGroups.map((g, i) => (
                          <div key={i} className="flex items-center justify-between gap-3 rounded-xl px-3 py-2.5" style={{ background: `${accentColor}12` }}>
                            <span className="text-sm text-white/80 truncate">
                              {g.source.album} <span className="text-white/40">— copy to {g.targets.length} song{g.targets.length !== 1 ? 's' : ''}</span>
                            </span>
                            <button disabled={applying} onClick={() => handleCopyArt(g.source, g.targets)}
                              className="flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-full shrink-0 transition-opacity hover:opacity-90 disabled:opacity-40"
                              style={{ background: accentColor, color: getContrastText(accentColor) }}>
                              <Copy size={12} /> Apply
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                    <h4 className="text-white/50 text-[11px] font-semibold uppercase tracking-wider mb-1">
                      {artCopyGroups.length > 0 ? 'Everything else' : `${report.missingArt.length} song${report.missingArt.length !== 1 ? 's' : ''}`}
                    </h4>
                    <div className="divide-y divide-white/5">
                      {report.missingArt.filter((s) => !artCopyTargetIds.has(s.id)).map((s) => (
                        <SongMiniRow key={s.id} song={s} right={
                          <button onClick={() => onEditArt(s)}
                            className="flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-full bg-white/5 hover:bg-white/10 transition-colors shrink-0" style={{ color: accentColor }}>
                            <Pencil size={12} /> Add art
                          </button>
                        } />
                      ))}
                    </div>
                  </div>
                )
              )}

              {/* ── Missing year ── */}
              {section === 'year' && (
                report.missingYear.length === 0 ? <Empty text="Every song has a year." /> : (
                  <BulkFixList
                    songs={report.missingYear}
                    selected={selectedYearIds}
                    onToggle={(id) => toggle(selectedYearIds, setSelectedYearIds, id)}
                    onSelectAll={() => setSelectedYearIds(new Set(report.missingYear.map((s) => s.id)))}
                    onClear={() => setSelectedYearIds(new Set())}
                    accentColor={accentColor}
                    inputPlaceholder="e.g. 2019"
                    inputValue={yearValue}
                    onInputChange={(v) => setYearValue(v.replace(/[^0-9]/g, '').slice(0, 4))}
                    onApply={applyYear}
                    applying={applying}
                    inputMode="numeric"
                  />
                )
              )}

              {/* ── Missing genre ── */}
              {section === 'genre' && (
                report.missingGenre.length === 0 ? <Empty text="Every song has a genre." /> : (
                  <BulkFixList
                    songs={report.missingGenre}
                    selected={selectedGenreIds}
                    onToggle={(id) => toggle(selectedGenreIds, setSelectedGenreIds, id)}
                    onSelectAll={() => setSelectedGenreIds(new Set(report.missingGenre.map((s) => s.id)))}
                    onClear={() => setSelectedGenreIds(new Set())}
                    accentColor={accentColor}
                    inputPlaceholder="e.g. Kollywood"
                    inputValue={genreValue}
                    onInputChange={setGenreValue}
                    onApply={applyGenre}
                    applying={applying}
                  />
                )
              )}

              {/* ── Inconsistent artist names ── */}
              {section === 'artists' && (
                report.artistVariantGroups.length === 0 ? <Empty text="No inconsistently-spelled artist names found." /> : (
                  <div className="space-y-4">
                    {report.artistVariantGroups.map((g) => (
                      <ArtistGroupCard key={g.normalized} group={g} accentColor={accentColor} applying={applying}
                        onMerge={(canonical) => mergeGroup(g, canonical)} />
                    ))}
                  </div>
                )
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return <p className="text-white/30 text-sm py-6 text-center">{text}</p>;
}

function BulkFixList({ songs, selected, onToggle, onSelectAll, onClear, accentColor, inputPlaceholder, inputValue, onInputChange, onApply, applying, inputMode }: {
  songs: Song[]; selected: Set<string>; onToggle: (id: string) => void; onSelectAll: () => void; onClear: () => void;
  accentColor: string; inputPlaceholder: string; inputValue: string; onInputChange: (v: string) => void;
  onApply: () => void; applying: boolean; inputMode?: 'numeric' | 'text';
}) {
  return (
    <div>
      <div className="flex items-center gap-2 mb-3">
        <span className="text-white/40 text-xs">{selected.size} of {songs.length} selected</span>
        <button onClick={onSelectAll} className="text-xs text-white/40 hover:text-white/70 transition-colors ml-2">Select all</button>
        {selected.size > 0 && <button onClick={onClear} className="text-xs text-white/40 hover:text-white/70 transition-colors">Clear</button>}
        <div className="ml-auto flex items-center gap-2">
          <input value={inputValue} onChange={(e) => onInputChange(e.target.value)} placeholder={inputPlaceholder}
            inputMode={inputMode === 'numeric' ? 'numeric' : undefined}
            className="w-32 px-3 py-1.5 rounded-lg bg-white/5 border border-white/10 text-white text-sm placeholder:text-white/25 focus:outline-none focus:border-white/30 transition-colors" />
          <button onClick={onApply} disabled={applying || selected.size === 0 || !inputValue.trim()}
            className="text-xs font-semibold px-3 py-1.5 rounded-full shrink-0 transition-opacity hover:opacity-90 disabled:opacity-40"
            style={{ background: accentColor, color: getContrastText(accentColor) }}>
            Apply to {selected.size || ''}
          </button>
        </div>
      </div>
      <div className="divide-y divide-white/5">
        {songs.map((s) => (
          <SongMiniRow key={s.id} song={s} right={
            <button onClick={() => onToggle(s.id)}
              className="w-5 h-5 rounded-md flex items-center justify-center shrink-0 border transition-colors"
              style={selected.has(s.id) ? { background: accentColor, borderColor: accentColor } : { borderColor: 'rgba(255,255,255,0.25)' }}>
              {selected.has(s.id) && <Check size={13} className="text-black" />}
            </button>
          } />
        ))}
      </div>
    </div>
  );
}

function ArtistGroupCard({ group, accentColor, applying, onMerge }: {
  group: ArtistVariantGroup; accentColor: string; applying: boolean; onMerge: (canonical: string) => void;
}) {
  const [canonical, setCanonical] = useState(group.variants[0].name);
  const totalSongs = group.variants.reduce((n, v) => n + v.count, 0);
  return (
    <div className="rounded-xl p-3" style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)' }}>
      <p className="text-white/40 text-[11px] mb-2">{group.variants.length} spellings across {totalSongs} song{totalSongs !== 1 ? 's' : ''} — pick the one to keep:</p>
      <div className="space-y-1.5 mb-3">
        {group.variants.map((v) => (
          <label key={v.name} className="flex items-center gap-2.5 cursor-pointer group">
            <input type="radio" name={`variant-${group.normalized}`} checked={canonical === v.name}
              onChange={() => setCanonical(v.name)} className="accent-current" style={{ color: accentColor }} />
            <span className="text-sm text-white/85 truncate">{v.name}</span>
            <span className="text-xs text-white/30 ml-auto shrink-0">{v.count} song{v.count !== 1 ? 's' : ''}</span>
          </label>
        ))}
      </div>
      <button onClick={() => onMerge(canonical)} disabled={applying}
        className="w-full text-xs font-semibold py-2 rounded-lg transition-opacity hover:opacity-90 disabled:opacity-40"
        style={{ background: accentColor, color: getContrastText(accentColor) }}>
        Merge as "{canonical}"
      </button>
    </div>
  );
}
