import { useEffect, useMemo, useState } from 'react';
import { ChevronLeft, Flame, Clock4, Music2 } from 'lucide-react';
import type { HistoryEntry, Song } from '../types';
import type { ListeningSession } from '../hooks/useListeningStats';
import { computeTopArtists, computeHourHistogram, computeStreak, computeGenreOverTime } from '../lib/deepStats';
import { getHistory } from '../lib/db';

interface Props {
  songs: Song[];
  sessions: ListeningSession[];
  accentColor: string;
  onClose: () => void;
}

// Small fixed categorical palette for the genre-over-time legend -- distinct
// hues are needed to tell up to 5 genre segments apart within one stacked
// bar, which a single accent-color tint can't do on its own.
const GENRE_PALETTE = ['#2C5FCC', '#22C55E', '#F59E0B', '#EF4444', '#A855F7'];

const HOUR_LABELS = ['12a', '1a', '2a', '3a', '4a', '5a', '6a', '7a', '8a', '9a', '10a', '11a',
  '12p', '1p', '2p', '3p', '4p', '5p', '6p', '7p', '8p', '9p', '10p', '11p'];

export function YearInMusicDetail({ songs, sessions, accentColor, onClose }: Props) {
  const [fullHistory, setFullHistory] = useState<HistoryEntry[] | null>(null);

  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);

  // Genre-over-time needs the full play history, not just the 50-entry
  // "Recently Played" slice the rest of the Stats screen uses -- fetched
  // once, on open.
  useEffect(() => { getHistory(Number.MAX_SAFE_INTEGER).then(setFullHistory); }, []);

  const topArtists = useMemo(() => computeTopArtists(songs, 10), [songs]);
  const hours = useMemo(() => computeHourHistogram(sessions), [sessions]);
  const streak = useMemo(() => computeStreak(sessions), [sessions]);
  const genreOverTime = useMemo(
    () => (fullHistory ? computeGenreOverTime(fullHistory, songs) : { buckets: [], topGenres: [] }),
    [fullHistory, songs],
  );

  const maxHourMin = Math.max(1, ...hours.minutesByHour);
  const maxArtistPlays = topArtists[0]?.plays ?? 1;

  const peakLabel = hours.minutesByHour.some((m) => m > 0) ? HOUR_LABELS[hours.peakHour] : null;

  return (
    <div className="fixed inset-0 z-[60] flex flex-col animate-fade-in" style={{ background: '#0a0a0a' }}>
      <div className="flex items-center gap-3 px-4 pt-4 pb-3 shrink-0">
        <button onClick={onClose} className="btn-icon w-9 h-9 hover:bg-white/10 rounded-full -ml-1.5">
          <ChevronLeft size={22} className="text-white" />
        </button>
        <h2 className="text-white font-bold text-lg">Year in Music</h2>
      </div>

      <div className="flex-1 overflow-y-auto px-5 pb-10">
        {/* ── Top Artists ── */}
        <section className="mb-8">
          <h3 className="text-white/60 text-xs font-semibold uppercase tracking-wider mb-3 flex items-center gap-2">
            <Music2 size={14} style={{ color: accentColor }} /> Top Artists
          </h3>
          {topArtists.length === 0 ? (
            <p className="text-white/25 text-sm py-4">No plays counted yet.</p>
          ) : (
            <div className="space-y-2">
              {topArtists.map((a, i) => {
                const pct = (a.plays / maxArtistPlays) * 100;
                return (
                  <div key={a.name} className="flex items-center gap-3">
                    <span className="text-[11px] font-bold w-5 h-5 rounded-full flex items-center justify-center shrink-0"
                      style={{ background: i < 3 ? `${accentColor}30` : 'rgba(255,255,255,0.06)', color: i < 3 ? accentColor : 'rgba(255,255,255,0.4)' }}>{i + 1}</span>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between gap-2 mb-1">
                        <p className="text-sm font-medium text-white/90 truncate">{a.name}</p>
                        <span className="text-xs font-bold tabular-nums shrink-0" style={{ color: accentColor }}>{a.plays} play{a.plays === 1 ? '' : 's'}</span>
                      </div>
                      <div className="h-1 rounded-full bg-white/8 overflow-hidden">
                        <div className="h-full rounded-full" style={{ width: `${pct}%`, background: accentColor }} />
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>

        {/* ── Most-active listening hours ── */}
        <section className="mb-8">
          <h3 className="text-white/60 text-xs font-semibold uppercase tracking-wider mb-3 flex items-center gap-2">
            <Clock4 size={14} style={{ color: accentColor }} /> Most-Active Hours
          </h3>
          {peakLabel === null ? (
            <p className="text-white/25 text-sm py-4">No listening sessions recorded yet.</p>
          ) : (
            <>
              <p className="text-white/70 text-sm mb-4">
                You listen most around <span className="font-bold" style={{ color: accentColor }}>{peakLabel}</span>.
              </p>
              <div className="flex items-end gap-[3px]" style={{ height: 90 }}>
                {hours.minutesByHour.map((min, h) => {
                  const height = Math.max(2, (min / maxHourMin) * 100);
                  const isPeak = h === hours.peakHour && min > 0;
                  return (
                    <div key={h} className="flex-1 min-w-0 h-full flex flex-col justify-end items-center" title={`${HOUR_LABELS[h]}: ${min} min`}>
                      <div className="w-full rounded-sm" style={{ height: `${height}%`, background: isPeak ? accentColor : `${accentColor}55` }} />
                    </div>
                  );
                })}
              </div>
              <div className="flex gap-[3px] mt-1 text-[8px] text-white/25">
                {HOUR_LABELS.map((l, h) => (
                  <span key={h} className="flex-1 min-w-0 text-center">{h % 3 === 0 ? l : ''}</span>
                ))}
              </div>
            </>
          )}
        </section>

        {/* ── Longest streak ── */}
        <section className="mb-8">
          <h3 className="text-white/60 text-xs font-semibold uppercase tracking-wider mb-3 flex items-center gap-2">
            <Flame size={14} style={{ color: accentColor }} /> Listening Streak
          </h3>
          <div className="grid grid-cols-2 gap-3">
            <div className="rounded-2xl p-4" style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.06)' }}>
              <p className="text-3xl font-extrabold tabular-nums" style={{ color: accentColor }}>{streak.longest}</p>
              <p className="text-white/40 text-xs mt-1">Longest streak (days)</p>
            </div>
            <div className="rounded-2xl p-4" style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.06)' }}>
              <p className="text-3xl font-extrabold tabular-nums text-white">{streak.current}</p>
              <p className="text-white/40 text-xs mt-1">Current streak (days)</p>
            </div>
          </div>
        </section>

        {/* ── Genre breakdown over time ── */}
        <section>
          <h3 className="text-white/60 text-xs font-semibold uppercase tracking-wider mb-3">Genre Breakdown Over Time</h3>
          {fullHistory === null ? (
            <p className="text-white/25 text-sm py-4">Loading…</p>
          ) : genreOverTime.buckets.length === 0 ? (
            <p className="text-white/25 text-sm py-4">Tag some songs with a genre to see this over time.</p>
          ) : (
            <>
              <div className="flex flex-wrap gap-3 mb-4">
                {genreOverTime.topGenres.map((g, i) => (
                  <span key={g} className="flex items-center gap-1.5 text-xs text-white/50">
                    <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: GENRE_PALETTE[i % GENRE_PALETTE.length] }} />
                    {g}
                  </span>
                ))}
              </div>
              <div className="space-y-2.5">
                {genreOverTime.buckets.map((bucket) => {
                  const total = Object.values(bucket.genreCounts).reduce((a, b) => a + b, 0);
                  return (
                    <div key={bucket.key} className="flex items-center gap-3">
                      <span className="text-xs text-white/40 w-16 shrink-0">{bucket.label}</span>
                      <div className="flex-1 h-4 rounded-full overflow-hidden flex bg-white/5">
                        {genreOverTime.topGenres.map((g, i) => {
                          const count = bucket.genreCounts[g] ?? 0;
                          if (count === 0) return null;
                          return (
                            <div key={g} style={{ width: `${(count / total) * 100}%`, background: GENRE_PALETTE[i % GENRE_PALETTE.length] }} title={`${g}: ${count}`} />
                          );
                        })}
                      </div>
                      <span className="text-xs text-white/30 tabular-nums w-8 text-right shrink-0">{total}</span>
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </section>
      </div>
    </div>
  );
}
