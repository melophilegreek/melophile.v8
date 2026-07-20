// Shared helpers for `[mm:ss.xx]lyric text` (LRC) timestamps. Import-time
// detection (scanner.ts) and the Lyrics modal's own live/manual-edit
// detection used to each keep a separate copy of this regex, which is how
// they quietly drifted apart and let some synced songs fall back to a flat
// block of plain text. One shared, non-anchored pattern for both.
export interface LrcLine { time: number; text: string }

const LRC_LINE = /\[(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?\]/g;
// Non-global twin of LRC_LINE used purely for a yes/no "does this text carry
// timestamps" check — reusing the global regex for .test() would leave
// lastIndex in a bad state across calls.
const LRC_LINE_PROBE = /\[(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?\]/;

/** Does this text contain at least one `[mm:ss.xx]`-style timestamp
 *  anywhere? Intentionally not anchored to line start -- lyrics pasted,
 *  uploaded, or embedded by different taggers vary too much in leading
 *  whitespace/BOMs/etc. for an anchored check to be reliable. */
export function isLrcText(text: string | undefined | null): boolean {
  return !!text && LRC_LINE_PROBE.test(text);
}

export function detectLyricsFormat(text: string): 'lrc' | 'plain' {
  return isLrcText(text) ? 'lrc' : 'plain';
}

/** Parses `[mm:ss.xx]lyric text` lines (possibly several timestamps sharing
 *  one line of text, e.g. a repeated chorus) into a flat, time-sorted list.
 *
 *  BUG FIX: this used to `continue` (skip entirely) on any line with no
 *  timestamp of its own. Real lyrics aren't always stamped on every single
 *  line -- blank separators between verses, a stanza sharing one leading
 *  timestamp, or lyrics only partially annotated by whatever tagger wrote
 *  them -- and all of those lines were silently vanishing from the view,
 *  which is what made partially-timestamped songs look almost blank.
 *  Untimed lines are now kept and grouped under the most recent timestamp
 *  seen so far (or 0, for anything before the first timestamp), so nothing
 *  disappears -- they just won't advance the highlight on their own. */
export function parseLrc(raw: string): LrcLine[] {
  const lines: LrcLine[] = [];
  let lastTime = 0;
  for (const rawLine of raw.split('\n')) {
    const matches = Array.from(rawLine.matchAll(LRC_LINE));
    const text = rawLine.replace(LRC_LINE, '').trim();
    if (matches.length === 0) {
      if (text) lines.push({ time: lastTime, text });
      continue;
    }
    for (const m of matches) {
      const min = parseInt(m[1], 10);
      const sec = parseInt(m[2], 10);
      const frac = m[3] ? parseInt(m[3].padEnd(3, '0'), 10) / 1000 : 0;
      const time = min * 60 + sec + frac;
      lastTime = time;
      lines.push({ time, text });
    }
  }
  // Array.prototype.sort is stable (guaranteed since ES2019), so lines that
  // share a time value -- e.g. an untimed line grouped under the timestamp
  // above it -- keep their original relative order rather than getting
  // shuffled.
  return lines.sort((a, b) => a.time - b.time);
}
