import type { Song, HistoryEntry } from '../types';
import type { ListeningSession } from '../hooks/useListeningStats';
import { splitArtists } from './artistParser';

// Feature (Deeper personal stats): a "year in music" layer on top of the
// existing play-count stats -- top composers/artists (credit-split aware),
// most-active listening hours, longest listening streak, and genre
// breakdown over time.

export interface TopArtistStat { name: string; plays: number; songCount: number; }

/** Ranks every individually-credited artist (post split-credit -- see
 *  lib/artistParser) by total play count summed across every song they're
 *  credited on. Since Tamil film metadata (and similar) often lumps
 *  composer + singers into one Artist tag, this is deliberately labeled
 *  "Top Artists" rather than "Top Composers" in the UI -- the library has no
 *  separate role field, so a composer and a featured singer credited on the
 *  same tag are indistinguishable and both surface here. */
export function computeTopArtists(songs: Song[], limit = 10): TopArtistStat[] {
  const map = new Map<string, { plays: number; songIds: Set<string> }>();
  for (const s of songs) {
    const plays = s.playCount ?? 0;
    if (plays === 0) continue;
    for (const name of splitArtists(s.artist)) {
      const existing = map.get(name);
      if (existing) { existing.plays += plays; existing.songIds.add(s.id); }
      else map.set(name, { plays, songIds: new Set([s.id]) });
    }
  }
  return Array.from(map.entries())
    .map(([name, v]) => ({ name, plays: v.plays, songCount: v.songIds.size }))
    .sort((a, b) => b.plays - a.plays)
    .slice(0, limit);
}

export interface HourHistogram {
  /** Minutes listened in each hour-of-day bucket, 0 (midnight) through 23. */
  minutesByHour: number[];
  peakHour: number;
}

/** Buckets every listening session's start time by hour-of-day (local time)
 *  and sums minutes into each bucket -- "what time of day do you listen
 *  most", at hourly (not just morning/afternoon/evening/night) resolution. */
export function computeHourHistogram(sessions: ListeningSession[]): HourHistogram {
  const minutesByHour = new Array(24).fill(0);
  for (const s of sessions) {
    const hour = new Date(s.startTime).getHours();
    minutesByHour[hour] += s.durationInSeconds / 60;
  }
  const rounded = minutesByHour.map((m) => Math.round(m));
  let peakHour = 0;
  rounded.forEach((m, h) => { if (m > rounded[peakHour]) peakHour = h; });
  return { minutesByHour: rounded, peakHour };
}

export interface StreakStat { longest: number; current: number; }

/** Longest and current run of consecutive calendar days with at least one
 *  listening session. "Current" is 0 if yesterday-or-today had no listening
 *  (i.e. the streak has already been broken), otherwise it's the number of
 *  consecutive days ending today (or yesterday, if nothing's played yet
 *  today but the streak is still alive). */
export function computeStreak(sessions: ListeningSession[]): StreakStat {
  if (sessions.length === 0) return { longest: 0, current: 0 };
  const dayKeys = new Set<string>();
  for (const s of sessions) {
    const d = new Date(s.startTime);
    dayKeys.add(`${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`);
  }
  const days = Array.from(dayKeys).map((k) => {
    const [y, m, d] = k.split('-').map(Number);
    return new Date(y, m, d).getTime();
  }).sort((a, b) => a - b);

  const DAY_MS = 86400000;
  let longest = 1;
  let run = 1;
  for (let i = 1; i < days.length; i++) {
    if (days[i] - days[i - 1] === DAY_MS) { run++; longest = Math.max(longest, run); }
    else run = 1;
  }

  // Current streak: walk back from the most recent listening day only if
  // that day is today or yesterday (otherwise the streak is over).
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const mostRecent = days[days.length - 1];
  const daysSinceRecent = Math.round((today.getTime() - mostRecent) / DAY_MS);
  let current = 0;
  if (daysSinceRecent <= 1) {
    current = 1;
    for (let i = days.length - 1; i > 0; i--) {
      if (days[i] - days[i - 1] === DAY_MS) current++;
      else break;
    }
  }
  return { longest, current };
}

export interface GenreMonthBucket { key: string; label: string; genreCounts: Record<string, number>; }

/** Groups play history by calendar month, counting plays per genre within
 *  each month (genre comes from the song's own `genre` field, looked up per
 *  history entry). Months with no history are omitted -- unlike
 *  TimeListenedDetail's month list, this is a breakdown chart, not a
 *  complete timeline, so empty months would just be empty bars. Returned
 *  oldest-first. Entries whose song has no genre set, or whose song has
 *  since been deleted, are skipped -- they can't contribute to a genre
 *  breakdown. */
export function computeGenreOverTime(history: HistoryEntry[], songs: Song[]): { buckets: GenreMonthBucket[]; topGenres: string[] } {
  const songById = new Map(songs.map((s) => [s.id, s] as const));
  const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const byMonth = new Map<string, Record<string, number>>();
  const genreTotals = new Map<string, number>();

  for (const entry of history) {
    const song = songById.get(entry.songId);
    const genre = song?.genre?.trim();
    if (!genre) continue;
    const d = new Date(entry.playedAt);
    const key = `${d.getFullYear()}-${String(d.getMonth()).padStart(2, '0')}`;
    const counts = byMonth.get(key) ?? {};
    counts[genre] = (counts[genre] ?? 0) + 1;
    byMonth.set(key, counts);
    genreTotals.set(genre, (genreTotals.get(genre) ?? 0) + 1);
  }

  const topGenres = Array.from(genreTotals.entries()).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([g]) => g);

  const buckets: GenreMonthBucket[] = Array.from(byMonth.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, genreCounts]) => {
      const [y, m] = key.split('-').map(Number);
      return { key, label: `${MONTH_NAMES[m]} ${y}`, genreCounts };
    });

  return { buckets, topGenres };
}
