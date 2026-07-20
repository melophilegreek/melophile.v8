import { useEffect, useRef, useState } from 'react';
import { X, Check, Heart, Trash2, AlertTriangle, Sparkles, ImagePlus, Download, Upload, SlidersHorizontal, FolderOpen } from 'lucide-react';
import type { ArtRescanProgress } from '../lib/scanner';
import { getContrastText } from '../lib/color';
import { Slider } from './Slider';
import { EQ_BANDS, EQ_PRESETS, EQ_MIN_DB, EQ_MAX_DB, matchPreset, type EQBandKey, type EQState } from '../lib/eqPresets';

const PRESETS = [
  { name: 'Green', color: '#1DB954' }, { name: 'Purple', color: '#9B59B6' },
  { name: 'Blue', color: '#3498DB' }, { name: 'Red', color: '#E74C3C' },
  { name: 'Orange', color: '#E67E22' }, { name: 'Pink', color: '#FF6B9D' },
  { name: 'Teal', color: '#1ABC9C' }, { name: 'Gold', color: '#F1C40F' },
];

// Extra jewel-tone / metallic palette, kept separate from PRESETS above so
// the original 8 colors are untouched — just an additional row of options.
const PREMIUM_PRESETS = [
  { name: 'Rose Gold', color: '#E0A899' }, { name: 'Platinum', color: '#D4D8DD' },
  { name: 'Champagne', color: '#E6C79C' }, { name: 'Sapphire', color: '#2C5FCC' },
  { name: 'Emerald', color: '#0E9F6E' }, { name: 'Amethyst', color: '#A855F7' },
  { name: 'Ruby', color: '#E11D48' }, { name: 'Bronze', color: '#C08552' },
];

interface Props {
  accentColor: string;
  onAccentChange: (color: string) => void;
  onClose: () => void;
  /** Current library size — used to disable the delete-all action and
   *  word the confirmation dialog (e.g. "Delete 850 songs?"). */
  songCount: number;
  onDeleteAllSongs: () => void | Promise<void>;
  /** Re-scans every song's album art against its already-stored audio blob
   *  (see scanner.ts's rescanMissingArt for why this is needed). */
  onRescanArt: () => void | Promise<void>;
  /** Live progress while a rescan is running; null when idle. */
  artRescan: (ArtRescanProgress & { running: boolean }) | null;
  /** Feature (Gapless/Crossfade) */
  crossfadeSeconds: number;
  onCrossfadeChange: (seconds: number) => void;
  /** Feature (5-band EQ + presets) */
  eq: EQState;
  onEQChange: (band: EQBandKey, db: number) => void;
  onEQPreset: (bands: EQState) => void;
  /** Feature (Library backup/restore) */
  onExportBackup: () => void;
  onImportBackupFile: (file: File) => Promise<{ matchedSongs: number; unmatchedSongs: number; playlistsCreated: number }>;
  /** Feature (Auto Rescan): whether the browser supports the File System
   *  Access API this relies on (Chromium only — Chrome/Edge desktop and
   *  Android; not Safari, not Firefox). */
  autoRescanSupported: boolean;
  autoRescanEnabled: boolean;
  /** Name of the currently-watched folder, shown once enabled. */
  autoRescanFolderName?: string;
  onEnableAutoRescan: () => void | Promise<void>;
  onDisableAutoRescan: () => void | Promise<void>;
}

export function SettingsPanel({
  accentColor, onAccentChange, onClose, songCount, onDeleteAllSongs, onRescanArt, artRescan,
  crossfadeSeconds, onCrossfadeChange, eq, onEQChange, onEQPreset, onExportBackup, onImportBackupFile,
  autoRescanSupported, autoRescanEnabled, autoRescanFolderName, onEnableAutoRescan, onDisableAutoRescan,
}: Props) {
  const [hexInput, setHexInput] = useState(accentColor);
  const [confirmingDeleteAll, setConfirmingDeleteAll] = useState(false);
  const [deleting, setDeleting] = useState(false);
  // Fix (EQ user-friendliness): sliders default collapsed behind presets so
  // the common case (tap a preset) doesn't force scrolling past 5 sliders;
  // auto-expands once someone actually has a hand-tuned ("Custom") curve so
  // it doesn't hide their own settings from them on return visits.
  const [eqExpanded, setEqExpanded] = useState(() => matchPreset(eq) === null);
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<string | null>(null);
  const importInputRef = useRef<HTMLInputElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);

  useEffect(() => { setHexInput(accentColor); }, [accentColor]);
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (confirmingDeleteAll) { setConfirmingDeleteAll(false); return; }
      onClose();
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose, confirmingDeleteAll]);

  const handleConfirmDeleteAll = async () => {
    setDeleting(true);
    try {
      await onDeleteAllSongs();
      setConfirmingDeleteAll(false);
      onClose();
    } finally {
      setDeleting(false);
    }
  };

  // Feature (Library backup/restore)
  const handleImportFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // allow re-selecting the same file next time
    if (!file) return;
    setImporting(true);
    setImportResult(null);
    try {
      const result = await onImportBackupFile(file);
      const parts = [`${result.matchedSongs} song${result.matchedSongs === 1 ? '' : 's'} restored`];
      if (result.playlistsCreated > 0) parts.push(`${result.playlistsCreated} playlist${result.playlistsCreated === 1 ? '' : 's'} created`);
      if (result.unmatchedSongs > 0) parts.push(`${result.unmatchedSongs} not found in your library yet`);
      setImportResult(parts.join(' · '));
    } catch (err) {
      console.error('Backup import failed', err);
      setImportResult('That file could not be read as a Melophile backup.');
    } finally {
      setImporting(false);
    }
  };

  const applyHex = (val: string) => {
    const n = val.startsWith('#') ? val : `#${val}`;
    if (/^#[0-9a-fA-F]{6}$/.test(n)) onAccentChange(n);
  };

  return (
    <div ref={overlayRef} className="fixed inset-0 z-50 flex items-center justify-center px-4"
      style={{ background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(8px)' }}
      onMouseDown={(e) => { if (e.target === overlayRef.current) onClose(); }}>
      <div className="w-full max-w-sm max-h-[85vh] overflow-y-auto rounded-2xl p-6 shadow-2xl animate-slide-up"
        style={{ background: 'rgba(28,28,28,0.95)', backdropFilter: 'blur(20px)', border: '1px solid rgba(255,255,255,0.1)', boxShadow: '0 8px 32px rgba(0,0,0,0.6)' }}>
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-white font-bold text-xl">Settings</h2>
          <button onClick={onClose} className="btn-icon w-8 h-8 hover:bg-white/10 rounded-full">
            <X size={18} className="text-white/60" />
          </button>
        </div>

        <h3 className="text-white/60 text-xs font-semibold uppercase tracking-wider mb-3">Accent Color</h3>
        <div className="grid grid-cols-4 gap-2 mb-4">
          {PRESETS.map((p) => {
            const active = accentColor.toLowerCase() === p.color.toLowerCase();
            return (
              <button key={p.color} onClick={() => { onAccentChange(p.color); setHexInput(p.color); }}
                className="relative h-10 rounded-xl flex items-center justify-center transition-transform hover:scale-105 active:scale-95"
                style={{ background: p.color, boxShadow: active ? `0 0 0 2px white, 0 0 0 4px ${p.color}` : 'none' }} title={p.name}>
                {active && <Check size={16} strokeWidth={3} style={{ color: getContrastText(p.color) }} />}
              </button>
            );
          })}
        </div>

        <h3 className="flex items-center gap-1.5 text-amber-300/70 text-xs font-semibold uppercase tracking-wider mb-3">
          <Sparkles size={12} /> Premium
        </h3>
        <div className="grid grid-cols-4 gap-2 mb-4">
          {PREMIUM_PRESETS.map((p) => {
            const active = accentColor.toLowerCase() === p.color.toLowerCase();
            return (
              <button key={p.color} onClick={() => { onAccentChange(p.color); setHexInput(p.color); }}
                className="relative h-10 rounded-xl flex items-center justify-center transition-transform hover:scale-105 active:scale-95"
                style={{
                  background: `linear-gradient(135deg, ${p.color}, ${p.color}cc)`,
                  boxShadow: active
                    ? `0 0 0 2px white, 0 0 0 4px ${p.color}, 0 0 12px ${p.color}80`
                    : `0 0 8px ${p.color}40`,
                }}
                title={p.name}>
                {active && <Check size={16} strokeWidth={3} style={{ color: getContrastText(p.color) }} />}
              </button>
            );
          })}
        </div>

        <div className="flex items-center gap-2">
          <input type="text" value={hexInput} onChange={(e) => setHexInput(e.target.value)}
            onBlur={(e) => applyHex(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') applyHex(hexInput); }}
            placeholder="#2C5FCC"
            className="flex-1 bg-white/5 border border-white/10 rounded-xl px-3 py-2.5 text-white text-sm font-mono focus:outline-none focus:border-white/25 transition-colors" />
          <div className="relative w-10 h-10 rounded-xl overflow-hidden border border-white/20 cursor-pointer" style={{ background: accentColor }}>
            <input type="color" value={accentColor} onChange={(e) => { onAccentChange(e.target.value); setHexInput(e.target.value); }}
              className="absolute inset-0 w-full h-full opacity-0 cursor-pointer" />
          </div>
        </div>

        <div className="mt-4 p-3 rounded-xl bg-white/5 border border-white/5">
          <p className="text-white/40 text-xs mb-2">Preview</p>
          <div className="flex items-center gap-3">
            <div className="w-2 h-6 rounded-full" style={{ background: accentColor }} />
            <div className="flex-1 h-1.5 rounded-full bg-white/10">
              <div className="w-2/3 h-full rounded-full" style={{ background: accentColor }} />
            </div>
            <Heart size={16} fill={accentColor} style={{ color: accentColor }} />
          </div>
        </div>

        <button onClick={onClose} className="w-full mt-5 py-3 rounded-xl font-semibold transition-all hover:opacity-90 active:scale-[0.98]"
          style={{ background: accentColor, color: getContrastText(accentColor) }}>Done</button>

        {/* Feature (Gapless/Crossfade + Basic EQ) */}
        <div className="mt-5 pt-4 border-t border-white/10">
          <h3 className="text-white/60 text-xs font-semibold uppercase tracking-wider mb-3">Playback</h3>

          <div className="flex items-center justify-between mb-1.5">
            <label className="text-white/70 text-sm">Crossfade</label>
            <span className="text-white/40 text-xs tabular-nums">{crossfadeSeconds === 0 ? 'Off (gapless)' : `${crossfadeSeconds}s`}</span>
          </div>
          <Slider value={crossfadeSeconds} min={0} max={12} step={1}
            onChange={onCrossfadeChange}
            accentColor={accentColor} ariaLabel="Crossfade" className="w-full" />
          <p className="text-white/30 text-xs mt-1.5 mb-4 leading-snug">
            Overlaps the end of one track with the start of the next. At 0, tracks still transition without the usual gap — the next song is simply preloaded ahead of time instead of overlapping.
          </p>

          <div className="flex items-center gap-1.5 mb-2 text-white/70 text-sm">
            <SlidersHorizontal size={13} /> Equalizer
          </div>

          {/* Fix (EQ presets hidden behind invisible scrollbar): this used
              to be a single-row horizontal scroller with no scrollbar and no
              edge fade, so only ~4 of 10 presets were ever visible and
              nothing hinted more existed. Wrapping into a grid makes every
              preset visible up front with no hidden state. */}
          <div className="flex flex-wrap gap-1.5 mb-3">
            {EQ_PRESETS.map((preset) => {
              const active = matchPreset(eq) === preset.name;
              return (
                <button
                  key={preset.name}
                  onClick={() => onEQPreset(preset.bands)}
                  className="px-3 py-1.5 rounded-full text-xs font-medium border transition-colors whitespace-nowrap"
                  style={active
                    ? { background: accentColor, borderColor: accentColor, color: getContrastText(accentColor) }
                    : { background: 'transparent', borderColor: 'rgba(255,255,255,0.15)', color: 'rgba(255,255,255,0.6)' }}
                >
                  {preset.name}
                </button>
              );
            })}
          </div>

          {/* Fix (Reset duplicated Flat preset): a separate "Reset" button
              did exactly what the "Flat" preset pill already does, in two
              different places. Fine-tune toggle now doubles as the entry
              point to the sliders; Flat is the one and only way to zero
              them out. */}
          <button
            onClick={() => setEqExpanded((v) => !v)}
            className="flex items-center gap-1 text-white/40 hover:text-white/70 text-xs transition-colors mb-2"
          >
            <SlidersHorizontal size={11} className={eqExpanded ? '' : 'rotate-90'} style={{ transition: 'transform 0.15s' }} />
            {eqExpanded ? 'Hide fine-tune' : 'Fine-tune each band'}
          </button>

          {eqExpanded && (
            <div className="mb-1">
              <p className="text-white/30 text-xs mb-2 leading-snug">
                Gain per band in decibels (dB) — higher boosts that range, lower cuts it.
              </p>
              {EQ_BANDS.map(({ key, label, freq }) => (
                <div key={key} className="flex items-center gap-3 mb-2">
                  <span className="text-white/50 text-xs w-16 shrink-0 leading-tight">
                    {label}
                    <span className="block text-white/35 text-[11px]">{freq >= 1000 ? `${freq / 1000}kHz` : `${freq}Hz`}</span>
                  </span>
                  <Slider value={eq[key]} min={EQ_MIN_DB} max={EQ_MAX_DB} step={1}
                    onChange={(v) => onEQChange(key, v)}
                    accentColor={accentColor} ariaLabel={label} className="flex-1" />
                  <span className="text-white/40 text-xs w-9 text-right tabular-nums shrink-0">{eq[key] > 0 ? '+' : ''}{eq[key]}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="mt-5 pt-4 border-t border-white/10">
          <h3 className="text-white/60 text-xs font-semibold uppercase tracking-wider mb-3">Library</h3>
          <button
            onClick={onRescanArt}
            disabled={!!artRescan?.running || songCount === 0}
            className="w-full flex items-center justify-center gap-2 py-2.5 rounded-xl border border-white/10 text-white/70 text-sm font-medium transition-colors hover:bg-white/5 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent"
          >
            <ImagePlus size={15} />
            {artRescan?.running
              ? `Scanning… ${artRescan.current} / ${artRescan.total}${artRescan.found > 0 ? ` (found ${artRescan.found})` : ''}`
              : 'Fix missing album art'}
          </button>
          <p className="text-white/30 text-xs mt-2 leading-snug">
            Re-checks every song's embedded cover art against past parsing
            bugs (including corrupted art that looked "missing" but wasn't
            actually empty) and fixes any it finds. Scans your whole library,
            so it can take a bit for large collections. Songs whose files
            never had art won't be affected.
          </p>

          {/* Feature (Auto Rescan): lets a person pick their music folder
              once (via the File System Access API) instead of tapping the
              toolbar Rescan button every time — the app silently re-checks
              that folder for new files on every app open and whenever it
              regains focus. Only offered where the browser actually
              supports it; everyone else keeps using the toolbar button,
              which still works exactly as before. */}
          <div className="mt-4 pt-4 border-t border-white/10">
            <div className="flex items-center justify-between mb-1">
              <span className="text-white/70 text-sm font-medium">Auto rescan</span>
              {autoRescanEnabled && (
                <span className="text-[10px] font-bold px-2 py-0.5 rounded-full" style={{ background: `${accentColor}25`, color: accentColor }}>ON</span>
              )}
            </div>
            <p className="text-white/30 text-xs mb-3 leading-snug">
              {autoRescanSupported
                ? 'Automatically checks your music folder for new songs whenever you open the app — no need to tap Rescan yourself.'
                : "Not available in this browser — it needs a folder-access feature only Chrome and Edge currently support. Use the Rescan button in the toolbar instead."}
            </p>
            {autoRescanSupported && (
              autoRescanEnabled ? (
                <button
                  onClick={onDisableAutoRescan}
                  className="w-full flex items-center justify-center gap-2 py-2.5 rounded-xl border border-white/10 text-white/70 text-sm font-medium transition-colors hover:bg-white/5"
                >
                  <FolderOpen size={15} />
                  <span className="truncate">Watching "{autoRescanFolderName}" — tap to disable</span>
                </button>
              ) : (
                <button
                  onClick={onEnableAutoRescan}
                  className="w-full flex items-center justify-center gap-2 py-2.5 rounded-xl font-semibold transition-all hover:opacity-90 active:scale-[0.98]"
                  style={{ background: accentColor, color: getContrastText(accentColor) }}
                >
                  <FolderOpen size={15} />
                  Enable Auto Rescan
                </button>
              )
            )}
          </div>
        </div>

        {/* Feature (Library backup/restore) */}
        <div className="mt-5 pt-4 border-t border-white/10">
          <h3 className="text-white/60 text-xs font-semibold uppercase tracking-wider mb-3">Backup</h3>
          <div className="flex gap-2">
            <button onClick={onExportBackup} disabled={songCount === 0}
              className="flex-1 flex items-center justify-center gap-2 py-2.5 rounded-xl border border-white/10 text-white/70 text-sm font-medium transition-colors hover:bg-white/5 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent">
              <Download size={15} /> Export
            </button>
            <button onClick={() => importInputRef.current?.click()} disabled={importing}
              className="flex-1 flex items-center justify-center gap-2 py-2.5 rounded-xl border border-white/10 text-white/70 text-sm font-medium transition-colors hover:bg-white/5 disabled:opacity-40">
              <Upload size={15} /> {importing ? 'Importing…' : 'Import'}
            </button>
            <input ref={importInputRef} type="file" accept="application/json,.json" className="hidden" onChange={handleImportFile} />
          </div>
          {importResult && <p className="text-white/40 text-xs mt-2 leading-snug">{importResult}</p>}
          <p className="text-white/30 text-xs mt-2 leading-snug">
            Saves your liked songs, pinned songs, playlists, and play counts to a file — not the audio itself. Import that file after re-adding your music (on this device or a new one) to restore all of it.
          </p>
        </div>

        {/* Danger Zone: bulk-delete the entire library. Kept visually
            separated (border + red accents) from the accent-color settings
            above so it doesn't get clicked by accident. */}
        <div className="mt-5 pt-4 border-t border-white/10">
          <h3 className="text-red-400/80 text-xs font-semibold uppercase tracking-wider mb-3">Danger Zone</h3>
          <button
            onClick={() => setConfirmingDeleteAll(true)}
            disabled={songCount === 0}
            className="w-full flex items-center justify-center gap-2 py-2.5 rounded-xl border border-red-500/30 text-red-400 text-sm font-medium transition-colors hover:bg-red-500/10 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent"
          >
            <Trash2 size={15} />
            Delete all songs{songCount > 0 ? ` (${songCount})` : ''}
          </button>
        </div>
      </div>

      {confirmingDeleteAll && (
        <div className="fixed inset-0 z-[1200] flex items-center justify-center px-4"
          style={{ background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(8px)' }}
          onMouseDown={(e) => { if (e.currentTarget === e.target && !deleting) setConfirmingDeleteAll(false); }}>
          <div className="w-full max-w-sm rounded-2xl p-6 shadow-2xl animate-slide-up"
            style={{ background: 'rgba(28,28,28,0.97)', backdropFilter: 'blur(20px)', border: '1px solid rgba(239,68,68,0.25)', boxShadow: '0 8px 32px rgba(0,0,0,0.6)' }}>
            <div className="flex items-center gap-2.5 mb-2">
              <AlertTriangle size={18} className="text-red-400 shrink-0" />
              <h3 className="text-white font-bold text-lg">Delete all songs?</h3>
            </div>
            <p className="text-white/50 text-sm mb-5 leading-snug">
              <span className="text-white/80 font-medium">All {songCount} song{songCount === 1 ? '' : 's'}</span> in
              your library will be permanently removed, along with liked status and playlist entries. This can't be undone.
            </p>
            <div className="flex gap-2">
              <button onClick={() => setConfirmingDeleteAll(false)} disabled={deleting}
                className="flex-1 py-2.5 rounded-xl bg-white/5 hover:bg-white/10 text-white/70 text-sm transition-colors disabled:opacity-50">
                Cancel
              </button>
              <button onClick={handleConfirmDeleteAll} disabled={deleting}
                className="flex-1 py-2.5 rounded-xl bg-red-500/90 hover:bg-red-500 text-white font-semibold text-sm transition-colors disabled:opacity-70">
                {deleting ? 'Deleting…' : 'Delete all'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
