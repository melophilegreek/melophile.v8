import type { RepeatMode, ShuffleMode, Song } from '../types';
import { getFile } from './db';
import { EQ_BANDS, EQ_FLAT, clampEQ, type EQBandKey, type EQState } from './eqPresets';

type Listener = () => void;

export interface PlayerState {
  currentSong: Song | null;
  isPlaying: boolean;
  isLoading: boolean;
  currentTime: number;
  duration: number;
  volume: number;
  muted: boolean;
  shuffleMode: ShuffleMode;
  repeat: RepeatMode;
  queue: Song[];
  currentIndex: number;
  objectUrl: string | null;
  userQueue: Song[];
  /** Feature (Gapless/Crossfade): seconds of overlap between tracks. 0 means
   *  gapless-only (no overlap, but the next track's audio blob is still
   *  prefetched ahead of time so there's no IndexedDB-read gap). */
  crossfadeSeconds: number;
  /** Feature (5-band EQ): gain in dB per band, applied via a small Web
   *  Audio filter chain shared by both underlying <audio> elements. */
  eq: EQState;
  /** Feature (Sleep timer): epoch ms the timer will fire at, or null if a
   *  countdown timer isn't running. Mutually exclusive with
   *  sleepTimerEndOfTrack (only one sleep-timer mode is active at once). */
  sleepTimerEndsAt: number | null;
  /** Feature (Sleep timer): "pause after the current track finishes"
   *  instead of a fixed countdown. */
  sleepTimerEndOfTrack: boolean;
}

// DIAGNOSTIC (intermittent "song doesn't play" reports): the audio element's
// `error` event was previously caught with no logging at all, so a file that
// failed to decode (corrupt encode, container/codec the browser can't play,
// a bad blob URL, etc.) just silently reset isPlaying/isLoading with zero
// trace of why. MediaError only exposes a numeric `code`, so we map it to a
// human-readable reason here.
function describeMediaError(err: MediaError | null): string {
  if (!err) return 'unknown (no MediaError object present)';
  switch (err.code) {
    case MediaError.MEDIA_ERR_ABORTED: return 'MEDIA_ERR_ABORTED — fetching the media was aborted';
    case MediaError.MEDIA_ERR_NETWORK: return 'MEDIA_ERR_NETWORK — a network error occurred while fetching the media';
    case MediaError.MEDIA_ERR_DECODE: return 'MEDIA_ERR_DECODE — the media could not be decoded (corrupt file or unsupported encoding profile)';
    case MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED: return 'MEDIA_ERR_SRC_NOT_SUPPORTED — this format/codec is not supported by the browser';
    default: return `unrecognized error code ${err.code}`;
  }
}

function fisherYates<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

type Side = 'A' | 'B';

class Player {
  // Feature (Gapless/Crossfade + Basic EQ): two <audio> elements instead of
  // one. `audioA`/`audioB` are wired into the same small Web Audio filter
  // chain (see _setupAudioGraph). Ordinary playback always happens on
  // whichever one is "active" (this._active) -- the other one is only ever
  // used as scratch space while a crossfade transition is in flight, and
  // otherwise sits paused with no src.
  private readonly audioA = new Audio();
  private readonly audioB = new Audio();
  private _active: Side = 'A';
  private get activeAudio(): HTMLAudioElement { return this._active === 'A' ? this.audioA : this.audioB; }
  private get inactiveAudio(): HTMLAudioElement { return this._active === 'A' ? this.audioB : this.audioA; }
  private get inactiveSide(): Side { return this._active === 'A' ? 'B' : 'A'; }

  // Web Audio graph (created lazily on first play() -- AudioContext needs a
  // user gesture to start on most browsers, and play() is always reached via
  // one). Both elements feed the same bass/mid/treble filter chain, each
  // through its own gain node so we can fade one out while fading the other
  // in during a crossfade, and independently drive per-element volume.
  private ctx: AudioContext | null = null;
  private gainA: GainNode | null = null;
  private gainB: GainNode | null = null;
  private eqFilters: BiquadFilterNode[] = [];

  private _objectUrlA: string | null = null;
  private _objectUrlB: string | null = null;
  private _urlFor(side: Side) { return side === 'A' ? this._objectUrlA : this._objectUrlB; }
  private _setUrlFor(side: Side, url: string | null) { if (side === 'A') this._objectUrlA = url; else this._objectUrlB = url; }
  private _revokeUrlFor(side: Side) {
    const u = this._urlFor(side);
    if (u) { URL.revokeObjectURL(u); this._setUrlFor(side, null); }
  }

  // Feature (Gapless): caches the *next* song's audio blob a few seconds
  // before the current one ends, so the eventual loadSong() call for it
  // doesn't have to await an IndexedDB read -- that read (not decoding,
  // which is fast for local blobs) was the main source of a perceptible gap
  // between tracks.
  private _prefetch: { songId: string; blob: Blob } | null = null;
  private _prefetchInFlight: string | null = null;

  private _crossfading = false;
  private _crossfadeCleanupTimer: ReturnType<typeof setTimeout> | null = null;

  private _sleepTimerTimeout: ReturnType<typeof setTimeout> | null = null;

  // Feature (Lock-screen / notification controls): object URL for whatever
  // artwork is currently shown in the OS media-session UI. Revoked and
  // replaced whenever the current song (or its edited art) changes.
  private _mediaSessionArtUrl: string | null = null;

  private _state: PlayerState = {
    currentSong: null, isPlaying: false, isLoading: false,
    currentTime: 0, duration: 0, volume: 0.8, muted: false,
    shuffleMode: 'off', repeat: 'off',
    queue: [], currentIndex: -1, objectUrl: null, userQueue: [],
    crossfadeSeconds: 0, eq: EQ_FLAT,
    sleepTimerEndsAt: null, sleepTimerEndOfTrack: false,
  };
  private _library: Song[] = [];
  private _viewSongs: Song[] = [];
  private listeners = new Set<Listener>();
  // Monotonically increasing request id, used by loadSong() to detect and
  // discard stale async results (see the race-condition fix below).
  private _loadToken = 0;
  // Called when a song starts playing — used to log a "recently played"
  // history entry (this fires immediately, regardless of how much of the
  // song actually gets listened to).
  onPlayStart: ((song: Song) => void) | null = null;
  // Called at most once per continuous play session, the moment playback
  // position first crosses 75% of the song's duration — this is what
  // actually increments the song's play count (see TASK 3: a "play" only
  // counts once the listener has heard at least 75% of the track).
  onThresholdReached: ((song: Song) => void) | null = null;
  // TASK 3 (75%-threshold play counting): tracks whether the threshold has
  // already fired for the song currently loaded, so that scrubbing back
  // below 75% and letting playback cross it again doesn't fire a second
  // time for the same continuous listen. Reset whenever a genuinely new
  // playthrough starts (a different song loads, or repeat-one restarts the
  // same song from 0) — see loadSong() and the repeat-one branch of
  // _handleEnd() below.
  private _thresholdReached = false;

  constructor() {
    this._wireAudio(this.audioA);
    this._wireAudio(this.audioB);
    this._setupMediaSession();
  }

  // ── Web Audio graph (EQ + per-element crossfade gain) ──────────────────
  // Deferred until the first play() call: creating/resuming an AudioContext
  // before a user gesture just leaves it 'suspended' on most browsers, and
  // there's no benefit to constructing the graph earlier.
  private _ensureAudioGraph() {
    if (this.ctx) return;
    const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new Ctx();
    this.ctx = ctx;
    const filters = EQ_BANDS.map((band) => {
      const f = ctx.createBiquadFilter();
      f.type = band.type;
      f.frequency.value = band.freq;
      if (band.type === 'peaking') f.Q.value = 1.0;
      f.gain.value = this._state.eq[band.key];
      return f;
    });
    for (let i = 0; i < filters.length - 1; i++) filters[i].connect(filters[i + 1]);
    filters[filters.length - 1].connect(ctx.destination);
    this.eqFilters = filters;

    const gainA = ctx.createGain(); gainA.gain.value = 0;
    const gainB = ctx.createGain(); gainB.gain.value = 0;
    gainA.connect(filters[0]); gainB.connect(filters[0]);
    this.gainA = gainA; this.gainB = gainB;

    // Element volume/muted are deliberately left alone (always 1/false) --
    // once an element is routed into a MediaElementAudioSourceNode, actual
    // loudness is controlled entirely through its gain node instead, so
    // there's exactly one place (per element) driving volume, whether that's
    // "normal" playback or a crossfade ramp.
    const sourceA = ctx.createMediaElementSource(this.audioA);
    const sourceB = ctx.createMediaElementSource(this.audioB);
    sourceA.connect(gainA); sourceB.connect(gainB);
  }

  private _gainFor(side: Side): GainNode | null { return side === 'A' ? this.gainA : this.gainB; }

  private _effectiveVolume(): number { return this._state.muted ? 0 : this._state.volume; }

  /** Sets the active element's gain to the current volume and silences the
   *  inactive one -- the "steady state" (not mid-crossfade) gain layout. */
  private _applyVolumeSteadyState() {
    if (this._crossfading) return; // a scheduled ramp owns the gains right now
    const activeGain = this._gainFor(this._active);
    const inactiveGain = this._gainFor(this.inactiveSide);
    const v = this._effectiveVolume();
    const now = this.ctx?.currentTime ?? 0;
    if (activeGain) { activeGain.gain.cancelScheduledValues(now); activeGain.gain.setValueAtTime(v, now); }
    if (inactiveGain) { inactiveGain.gain.cancelScheduledValues(now); inactiveGain.gain.setValueAtTime(0, now); }
  }

  private _wireAudio(a: HTMLAudioElement) {
    a.volume = 1; // loudness is driven by the Web Audio gain nodes instead
    a.addEventListener('timeupdate', () => {
      if (a !== this.activeAudio) return; // background element mid-crossfade: ignore
      this._patch({ currentTime: a.currentTime });
      this._updateMediaSessionPosition();
      const song = this._state.currentSong;
      // TASK 3: fire the play-count callback the first time this continuous
      // session crosses 75% of the track's duration. Guarded by
      // _thresholdReached so it can only fire once per session.
      if (song && !this._thresholdReached && a.duration > 0 && isFinite(a.duration)) {
        if (a.currentTime / a.duration >= 0.75) {
          this._thresholdReached = true;
          this.onThresholdReached?.(song);
        }
      }
      // Feature (Gapless): prefetch the next song's blob a few seconds
      // ahead so the eventual transition doesn't wait on IndexedDB.
      const dur = this._state.duration;
      const remaining = dur - a.currentTime;
      const lookahead = Math.max(this._state.crossfadeSeconds, 4);
      if (dur > 0 && remaining > 0 && remaining <= lookahead) this._prefetchNext();
      // Feature (Crossfade): begin the overlap transition once we're inside
      // the configured crossfade window of the track's end.
      if (this._state.crossfadeSeconds > 0 && !this._crossfading && this._state.repeat !== 'one'
        && dur > 0 && remaining > 0 && remaining <= this._state.crossfadeSeconds) {
        this._beginCrossfade();
      }
    });
    a.addEventListener('durationchange', () => {
      if (a !== this.activeAudio) return;
      this._patch({ duration: isFinite(a.duration) ? a.duration : 0 });
    });
    a.addEventListener('playing', () => { if (a === this.activeAudio) this._patch({ isPlaying: true, isLoading: false }); });
    a.addEventListener('pause', () => { if (a === this.activeAudio) this._patch({ isPlaying: false }); });
    a.addEventListener('waiting', () => { if (a === this.activeAudio) this._patch({ isLoading: true }); });
    a.addEventListener('canplay', () => { if (a === this.activeAudio) this._patch({ isLoading: false }); });
    a.addEventListener('ended', () => { if (a === this.activeAudio) this._handleEnd(); });
    // DIAGNOSTIC: log which song failed and why, instead of failing silently.
    a.addEventListener('error', () => {
      if (a !== this.activeAudio) return; // a background element failing mid-crossfade isn't fatal
      console.error(
        `Playback error for "${this._state.currentSong?.title ?? 'unknown song'}"` +
        `${this._state.currentSong?.fileName ? ` (${this._state.currentSong.fileName})` : ''}: ` +
        describeMediaError(a.error),
        { song: this._state.currentSong, src: a.currentSrc, mediaError: a.error },
      );
      this._patch({ isLoading: false, isPlaying: false });
    });
  }

  get state(): PlayerState { return this._state; }
  private _patch(patch: Partial<PlayerState>) {
    this._state = { ...this._state, ...patch };
    if (typeof navigator !== 'undefined' && 'mediaSession' in navigator) {
      try { navigator.mediaSession.playbackState = this._state.isPlaying ? 'playing' : (this._state.currentSong ? 'paused' : 'none'); } catch { /* unsupported */ }
    }
    this.listeners.forEach((l) => l());
  }
  subscribe(fn: Listener) { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  setLibrary(library: Song[], viewSongs: Song[]) { this._library = library; this._viewSongs = viewSongs; }
  initQueue(songs: Song[]) { if (this._state.queue.length === 0) this._patch({ queue: songs, currentIndex: 0 }); }

  buildQueue(clickedSong: Song, viewSongs: Song[]): { queue: Song[]; idx: number } {
    const { shuffleMode } = this._state;
    if (shuffleMode === 'off') {
      const idx = viewSongs.findIndex((s) => s.id === clickedSong.id);
      return { queue: viewSongs, idx: idx >= 0 ? idx : 0 };
    }
    const source = shuffleMode === 'library' ? this._library : viewSongs;
    const rest = source.filter((s) => s.id !== clickedSong.id);
    return { queue: [clickedSong, ...fisherYates(rest)], idx: 0 };
  }

  /** Returns whichever song a natural forward advance would land on, WITHOUT
   *  mutating currentIndex/userQueue -- used to decide what to prefetch. */
  private _peekNext(): Song | null {
    const { queue, currentIndex, repeat, userQueue } = this._state;
    if (userQueue.length > 0) return userQueue[0];
    if (!queue.length) return null;
    let next = currentIndex + 1;
    if (next >= queue.length) { if (repeat === 'all') next = 0; else return null; }
    return queue[next] ?? null;
  }

  /** Advances currentIndex/userQueue exactly like a natural/manual "next"
   *  would, and returns the song that should now play (or null if there's
   *  nowhere to go). Shared by next() and the crossfade auto-advance path so
   *  both use identical queue-selection rules. */
  private _advanceQueueState(auto: boolean): Song | null {
    const { queue, currentIndex, repeat, userQueue } = this._state;
    if (userQueue.length > 0) {
      const nextSong = userQueue[0];
      this._patch({ userQueue: userQueue.slice(1) });
      return nextSong;
    }
    if (!queue.length) return null;
    let next = currentIndex + 1;
    if (next >= queue.length) {
      if (repeat === 'all') next = 0;
      else if (auto) return null;
      else next = 0;
    }
    this._patch({ currentIndex: next });
    return queue[next] ?? null;
  }

  /** Feature (Gapless): resolves a song's audio blob, preferring the
   *  prefetch cache over an IndexedDB read when it's already warm. */
  private async _getBlobFast(song: Song): Promise<Blob | undefined> {
    if (this._prefetch?.songId === song.id) return this._prefetch.blob;
    return getFile(song.fileKey);
  }

  private _prefetchNext() {
    const peeked = this._peekNext();
    if (!peeked) return;
    if (this._prefetch?.songId === peeked.id) return;
    if (this._prefetchInFlight === peeked.id) return;
    this._prefetchInFlight = peeked.id;
    getFile(peeked.fileKey).then((blob) => {
      if (blob) this._prefetch = { songId: peeked.id, blob };
    }).finally(() => {
      if (this._prefetchInFlight === peeked.id) this._prefetchInFlight = null;
    });
  }

  async loadSong(song: Song, autoplay = true) {
    // BUG FIX (race condition on rapid song change): loadSong is async
    // (it awaits an IndexedDB read via getFile), so calling next()/previous()
    // in quick succession could previously start several overlapping loads.
    // Each call gets a token; if a newer loadSong() has started by the time
    // this one's await resolves, this one bails out instead of touching the
    // audio element or state.
    const token = ++this._loadToken;
    // A manual load always targets the currently-active element and cancels
    // any in-flight crossfade (e.g. the user hit "next" mid-fade).
    this._cancelCrossfade();
    const audio = this.activeAudio;
    // New playthrough — reset the 75% play-count guard for TASK 3.
    this._thresholdReached = false;
    this._patch({ isLoading: true, currentSong: song });
    this._updateMediaSessionMetadata(song);
    if (autoplay && this.onPlayStart) this.onPlayStart(song);
    try {
      const blob = await this._getBlobFast(song);
      if (token !== this._loadToken) return; // superseded by a newer load
      if (!blob) {
        console.error(
          `loadSong: no stored audio blob found for "${song.title}" (fileKey: ${song.fileKey}). ` +
          `The song's IndexedDB file record is missing — it will not play.`,
          { song },
        );
        this._patch({ isLoading: false });
        return;
      }
      this._revokeUrlFor(this._active);
      const url = URL.createObjectURL(blob);
      this._setUrlFor(this._active, url);
      audio.src = url;
      audio.load();
      this._patch({ objectUrl: url });
      this._applyVolumeSteadyState();
      if (autoplay) await this.play();
    } catch (e) {
      if (token !== this._loadToken) return; // superseded, don't clobber newer state
      console.error(`loadSong failed for "${song.title}" (${song.fileName})`, e);
      this._patch({ isLoading: false });
    }
  }

  async playSong(song: Song, viewSongs: Song[]) {
    const { queue, idx } = this.buildQueue(song, viewSongs);
    this._patch({ queue, currentIndex: idx, userQueue: [] });
    await this.loadSong(song, true);
  }

  /** Add a song to the end of the user queue. */
  addToQueue(song: Song) {
    this._patch({ userQueue: [...this._state.userQueue, song] });
  }

  /** Add a song to the front of the user queue (play next). */
  playNext(song: Song) {
    this._patch({ userQueue: [song, ...this._state.userQueue] });
  }

  /** Remove a single entry from the user queue by its position. */
  removeFromQueue(index: number) {
    const uq = [...this._state.userQueue];
    if (index < 0 || index >= uq.length) return;
    uq.splice(index, 1);
    this._patch({ userQueue: uq });
  }

  /** Reorder: move queue item at `from` to `to` */
  reorderQueue(from: number, to: number) {
    const uq = [...this._state.userQueue];
    if (from < 0 || from >= uq.length || to < 0 || to >= uq.length) return;
    const [item] = uq.splice(from, 1);
    uq.splice(to, 0, item);
    this._patch({ userQueue: uq });
  }

  clearQueue() { this._patch({ userQueue: [] }); }

  /**
   * Remove a song from playback state after it has been deleted from the
   * library. Strips it out of the queue and user-queue so it can never be
   * navigated back to (its file/blob no longer exists in storage). If it
   * was the currently-playing song, playback is stopped and — if there is
   * anything left in the queue — advances to the next available song.
   */
  removeSong(songId: string) {
    const { queue, currentIndex, currentSong, userQueue } = this._state;
    const wasCurrent = currentSong?.id === songId;
    const removedIdx = queue.findIndex((s) => s.id === songId);
    const newQueue = queue.filter((s) => s.id !== songId);
    const newUserQueue = userQueue.filter((s) => s.id !== songId);

    if (!wasCurrent) {
      const newIndex = removedIdx !== -1 && removedIdx < currentIndex ? currentIndex - 1 : currentIndex;
      this._patch({ queue: newQueue, userQueue: newUserQueue, currentIndex: newIndex });
      return;
    }

    // The playing song itself was deleted: stop audio and release its blob URL.
    this._cancelCrossfade();
    this.activeAudio.pause();
    this.activeAudio.removeAttribute('src');
    this.activeAudio.load();
    this._revokeUrlFor(this._active);
    if (this._prefetch?.songId === songId) this._prefetch = null;

    if (newUserQueue.length > 0 || newQueue.length > 0) {
      if (newUserQueue.length > 0) {
        const nextSong = newUserQueue[0];
        this._patch({
          queue: newQueue, userQueue: newUserQueue.slice(1),
          currentSong: null, isPlaying: false, isLoading: false,
          currentTime: 0, duration: 0, objectUrl: null,
        });
        this.loadSong(nextSong, true);
        return;
      }
      const newIndex = Math.min(removedIdx, newQueue.length - 1);
      this._patch({
        queue: newQueue, userQueue: newUserQueue, currentIndex: newIndex,
        currentSong: null, isPlaying: false, isLoading: false,
        currentTime: 0, duration: 0, objectUrl: null,
      });
      this.loadSong(newQueue[newIndex], true);
      return;
    }

    this._patch({
      queue: [], userQueue: [], currentIndex: -1, currentSong: null,
      isPlaying: false, isLoading: false, currentTime: 0, duration: 0, objectUrl: null,
    });
  }

  async play() {
    if (!this.activeAudio.src) return;
    this._ensureAudioGraph();
    if (this.ctx && this.ctx.state === 'suspended') { try { await this.ctx.resume(); } catch { /* ignore */ } }
    this._applyVolumeSteadyState();
    try {
      await this.activeAudio.play();
    } catch (e) {
      console.error(
        `play() failed for "${this._state.currentSong?.title ?? 'unknown song'}": ${e instanceof Error ? e.name + ' — ' + e.message : e}`,
      );
      this._patch({ isPlaying: false, isLoading: false });
    }
  }
  pause() { this.activeAudio.pause(); }
  togglePlay() { if (this._state.isPlaying) this.pause(); else this.play(); }
  seek(time: number) { this.activeAudio.currentTime = Math.max(0, Math.min(time, this._state.duration)); }
  setVolume(v: number) { this._patch({ volume: v, muted: false }); this._applyVolumeSteadyState(); }
  setMuted(m: boolean) { this._patch({ muted: m }); this._applyVolumeSteadyState(); }

  // ── Feature (5-band EQ + presets) ─────────────────────────────────────────
  setEQBand(band: EQBandKey, db: number) {
    const clamped = clampEQ(db);
    this._ensureAudioGraph();
    const idx = EQ_BANDS.findIndex((b) => b.key === band);
    const filter = this.eqFilters[idx];
    if (filter) filter.gain.value = clamped;
    this._patch({ eq: { ...this._state.eq, [band]: clamped } });
  }
  /** Applies a full 5-band curve at once -- used both for restoring saved
   *  preferences on load and for one-tap presets (Bass Boost, Rock, etc). */
  setEQAll(eq: EQState) {
    this._ensureAudioGraph();
    EQ_BANDS.forEach((band, i) => {
      const clamped = clampEQ(eq[band.key]);
      if (this.eqFilters[i]) this.eqFilters[i].gain.value = clamped;
    });
    this._patch({ eq: { ...eq } });
  }

  // ── Feature (Gapless/Crossfade) ─────────────────────────────────────────
  setCrossfadeSeconds(sec: number) {
    this._patch({ crossfadeSeconds: Math.max(0, Math.min(12, sec)) });
  }

  private _cancelCrossfade() {
    if (this._crossfadeCleanupTimer) { clearTimeout(this._crossfadeCleanupTimer); this._crossfadeCleanupTimer = null; }
    if (this._crossfading) {
      // A fresh manual load/crossfade needs the inactive element free —
      // immediately silence and stop whatever was still fading out.
      const g = this._gainFor(this.inactiveSide);
      if (g && this.ctx) { g.gain.cancelScheduledValues(this.ctx.currentTime); g.gain.setValueAtTime(0, this.ctx.currentTime); }
      this.inactiveAudio.pause();
      this.inactiveAudio.removeAttribute('src');
      this.inactiveAudio.load();
      this._revokeUrlFor(this.inactiveSide);
      this._crossfading = false;
    }
  }

  private async _beginCrossfade() {
    const nextSong = this._advanceQueueState(true);
    if (!nextSong) return; // end of queue with no repeat — let natural 'ended' handle stopping
    this._crossfading = true;
    this._ensureAudioGraph();
    const fadeSec = this._state.crossfadeSeconds;
    const oldSide = this._active;
    const newSide = this.inactiveSide;
    const oldAudio = this.activeAudio;
    const newAudio = this.inactiveAudio;

    let blob: Blob | undefined;
    try { blob = await this._getBlobFast(nextSong); } catch { blob = undefined; }
    if (!blob) { this._crossfading = false; return; } // best-effort: skip the fade, natural 'ended' path still fires for oldAudio

    this._revokeUrlFor(newSide);
    const url = URL.createObjectURL(blob);
    this._setUrlFor(newSide, url);
    newAudio.src = url;
    newAudio.load();

    this._thresholdReached = false;
    this._active = newSide; // flip immediately: state below now tracks the incoming track
    const token = ++this._loadToken;
    this._patch({ currentSong: nextSong, currentTime: 0, duration: nextSong.duration || 0, isPlaying: true, objectUrl: url });
    this._updateMediaSessionMetadata(nextSong);
    this.onPlayStart?.(nextSong);

    try {
      if (token === this._loadToken) await newAudio.play();
    } catch (e) {
      console.error(`crossfade play() failed for "${nextSong.title}"`, e);
    }

    const ctx = this.ctx;
    const outGain = this._gainFor(oldSide);
    const inGain = this._gainFor(newSide);
    const v = this._effectiveVolume();
    if (ctx && outGain && inGain) {
      const now = ctx.currentTime;
      outGain.gain.cancelScheduledValues(now);
      outGain.gain.setValueAtTime(outGain.gain.value, now);
      outGain.gain.linearRampToValueAtTime(0, now + fadeSec);
      inGain.gain.cancelScheduledValues(now);
      inGain.gain.setValueAtTime(0, now);
      inGain.gain.linearRampToValueAtTime(v, now + fadeSec);
    }

    this._crossfadeCleanupTimer = setTimeout(() => {
      oldAudio.pause();
      oldAudio.removeAttribute('src');
      oldAudio.load();
      this._revokeUrlFor(oldSide);
      this._crossfading = false;
      this._crossfadeCleanupTimer = null;
    }, fadeSec * 1000 + 80);
  }

  // ── Feature (Sleep timer) ───────────────────────────────────────────────
  /** Pass a number of minutes for a countdown, 'end-of-track' to pause once
   *  the current song finishes, or null to cancel any active sleep timer. */
  setSleepTimer(minutes: number | 'end-of-track' | null) {
    if (this._sleepTimerTimeout) { clearTimeout(this._sleepTimerTimeout); this._sleepTimerTimeout = null; }
    if (minutes === null) { this._patch({ sleepTimerEndsAt: null, sleepTimerEndOfTrack: false }); return; }
    if (minutes === 'end-of-track') { this._patch({ sleepTimerEndsAt: null, sleepTimerEndOfTrack: true }); return; }
    const endsAt = Date.now() + minutes * 60_000;
    this._patch({ sleepTimerEndsAt: endsAt, sleepTimerEndOfTrack: false });
    this._sleepTimerTimeout = setTimeout(() => {
      this.pause();
      this._patch({ sleepTimerEndsAt: null });
      this._sleepTimerTimeout = null;
    }, minutes * 60_000);
  }

  setShuffle(mode: ShuffleMode) {
    if (mode === this._state.shuffleMode) return;
    const { queue, currentIndex } = this._state;
    const current = queue[currentIndex];
    if (mode === 'off') {
      const source = this._viewSongs;
      const idx = current ? source.findIndex((s) => s.id === current.id) : 0;
      this._patch({ shuffleMode: mode, queue: source, currentIndex: idx >= 0 ? idx : 0 });
    } else {
      const source = mode === 'library' ? this._library : this._viewSongs;
      const rest = current ? source.filter((s) => s.id !== current.id) : source;
      const shuffled = current ? [current, ...fisherYates(rest)] : fisherYates(rest);
      this._patch({ shuffleMode: mode, queue: shuffled, currentIndex: 0 });
    }
  }

  setRepeat(mode: RepeatMode) { this._patch({ repeat: mode }); }

  async next(auto = false) {
    if (!this._state.queue.length && !this._state.userQueue.length) return;
    this._cancelCrossfade();
    const nextSong = this._advanceQueueState(auto);
    if (!nextSong) { if (auto) this._patch({ isPlaying: false }); return; }
    await this.loadSong(nextSong, true);
  }

  async previous() {
    const { queue, currentIndex, repeat } = this._state;
    if (!queue.length) return;
    if (this.activeAudio.currentTime > 3) { this.seek(0); return; }
    this._cancelCrossfade();
    let prev = currentIndex - 1;
    if (prev < 0) prev = repeat === 'all' ? queue.length - 1 : 0;
    this._patch({ currentIndex: prev });
    await this.loadSong(queue[prev], true);
  }

  private _handleEnd() {
    // Feature (Sleep timer, end-of-track mode): stop right here instead of
    // advancing, and consume the flag so playback doesn't just pause again
    // on the following track too.
    if (this._state.sleepTimerEndOfTrack) {
      this.pause();
      this._patch({ sleepTimerEndOfTrack: false });
      return;
    }
    const { repeat } = this._state;
    if (repeat === 'one') {
      this._thresholdReached = false;
      this.seek(0); this.play(); return;
    }
    this.next(true);
  }

  /**
   * Full reset for "delete all songs" — every currently-loaded/queued song is
   * about to stop existing in storage, so unlike removeSong() (which tries to
   * advance to the next available track) there is nothing left to advance to.
   */
  clearAll() {
    this._cancelCrossfade();
    this.activeAudio.pause();
    this.activeAudio.removeAttribute('src');
    this.activeAudio.load();
    this._revokeUrlFor(this._active);
    this._prefetch = null;
    this._library = [];
    this._viewSongs = [];
    this._patch({
      queue: [], userQueue: [], currentIndex: -1, currentSong: null,
      isPlaying: false, isLoading: false, currentTime: 0, duration: 0, objectUrl: null,
    });
  }

  patchCurrentSong(updated: Song) {
    if (this._state.currentSong?.id === updated.id) {
      this._patch({ currentSong: updated });
      this._updateMediaSessionMetadata(updated);
    }
  }

  // ── Feature (Lock-screen & notification controls / Media Session) ───────
  private _setupMediaSession() {
    if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return;
    const ms = navigator.mediaSession;
    try {
      ms.setActionHandler('play', () => this.play());
      ms.setActionHandler('pause', () => this.pause());
      ms.setActionHandler('previoustrack', () => this.previous());
      ms.setActionHandler('nexttrack', () => this.next(false));
      ms.setActionHandler('stop', () => this.pause());
      ms.setActionHandler('seekto', (details) => {
        if (typeof details.seekTime === 'number') this.seek(details.seekTime);
      });
      ms.setActionHandler('seekbackward', (details) => {
        this.seek(this.activeAudio.currentTime - (details.seekOffset ?? 10));
      });
      ms.setActionHandler('seekforward', (details) => {
        this.seek(this.activeAudio.currentTime + (details.seekOffset ?? 10));
      });
    } catch {
      // Some browsers don't support every action; ignore individual failures.
    }
  }

  private _updateMediaSessionMetadata(song: Song) {
    if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return;
    if (this._mediaSessionArtUrl) { URL.revokeObjectURL(this._mediaSessionArtUrl); this._mediaSessionArtUrl = null; }
    let artwork: MediaImage[] = [];
    if (song.albumArtData) {
      const url = URL.createObjectURL(new Blob([song.albumArtData], { type: song.albumArtMime || 'image/jpeg' }));
      this._mediaSessionArtUrl = url;
      artwork = [{ src: url, sizes: '512x512', type: song.albumArtMime || 'image/jpeg' }];
    }
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: song.title, artist: song.artist, album: song.album || '', artwork,
      });
    } catch { /* MediaMetadata unsupported */ }
  }

  private _updateMediaSessionPosition() {
    if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return;
    const { duration, currentTime } = this._state;
    if (!(duration > 0) || !isFinite(duration)) return;
    try {
      navigator.mediaSession.setPositionState?.({ duration, playbackRate: 1, position: Math.min(currentTime, duration) });
    } catch { /* invalid state (e.g. still loading) -- ignore */ }
  }
}

export const player = new Player();
