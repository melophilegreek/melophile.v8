// Feature (5-band EQ + presets): band layout and preset gain curves live
// here so player.ts (audio graph), db.ts (persistence default), and
// SettingsPanel.tsx (UI) all reference the same single source of truth
// instead of three independently-maintained copies.

/** Five bands spanning bass through treble. Frequencies chosen to give each
 *  slider a distinct, audible role: 60Hz (sub/bass), 250Hz (low-mid/warmth),
 *  1kHz (mid/vocal body), 4kHz (high-mid/presence), 12kHz (air/treble). */
export const EQ_BANDS = [
  { key: 'band60', label: 'Bass', freq: 60, type: 'lowshelf' as const },
  { key: 'band250', label: 'Low Mid', freq: 250, type: 'peaking' as const },
  { key: 'band1k', label: 'Mid', freq: 1000, type: 'peaking' as const },
  { key: 'band4k', label: 'High Mid', freq: 4000, type: 'peaking' as const },
  { key: 'band12k', label: 'Treble', freq: 12000, type: 'highshelf' as const },
] as const;

export type EQBandKey = typeof EQ_BANDS[number]['key'];
export type EQState = Record<EQBandKey, number>;

/** Widened from the old ±12dB range so Bass Boost / Rock / Electronic presets
 *  below have real headroom to be felt, not just nudged. */
export const EQ_MIN_DB = -20;
export const EQ_MAX_DB = 20;

export const EQ_FLAT: EQState = { band60: 0, band250: 0, band1k: 0, band4k: 0, band12k: 0 };

export function clampEQ(db: number): number {
  return Math.max(EQ_MIN_DB, Math.min(EQ_MAX_DB, db));
}

export interface EQPreset {
  name: string;
  bands: EQState;
}

export const EQ_PRESETS: EQPreset[] = [
  { name: 'Flat', bands: EQ_FLAT },
  { name: 'Bass Boost', bands: { band60: 9, band250: 5, band1k: 0, band4k: -2, band12k: -1 } },
  { name: 'Treble Boost', bands: { band60: -2, band250: -1, band1k: 0, band4k: 5, band12k: 8 } },
  { name: 'Vocal Boost', bands: { band60: -3, band250: -1, band1k: 5, band4k: 5, band12k: 1 } },
  { name: 'Rock', bands: { band60: 6, band250: 3, band1k: -2, band4k: 3, band12k: 5 } },
  { name: 'Pop', bands: { band60: -1, band250: 2, band1k: 4, band4k: 3, band12k: -1 } },
  { name: 'Jazz', bands: { band60: 4, band250: 2, band1k: -1, band4k: 2, band12k: 4 } },
  { name: 'Classical', bands: { band60: 4, band250: 3, band1k: -2, band4k: 2, band12k: 5 } },
  { name: 'Electronic', bands: { band60: 7, band250: 3, band1k: 0, band4k: 2, band12k: 6 } },
  { name: 'Acoustic', bands: { band60: 3, band250: 2, band1k: 1, band4k: 3, band12k: 3 } },
];

/** Finds the preset matching the current EQ state exactly, or null if the
 *  user has hand-tuned sliders away from any known preset ("Custom"). */
export function matchPreset(eq: EQState): string | null {
  for (const p of EQ_PRESETS) {
    if (EQ_BANDS.every((b) => p.bands[b.key] === eq[b.key])) return p.name;
  }
  return null;
}
