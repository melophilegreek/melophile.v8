import { useCallback, useRef, useState } from 'react';

// Feature (convenient sliders): native <input type="range"> has a thin
// track and a small thumb that's genuinely hard to grab precisely on a
// touch screen, especially inside a scrollable panel where a near-miss
// touch just scrolls the page instead. This custom slider fixes the
// ergonomics without changing any call site's mental model (value/min/max/
// step/onChange, same as the native element):
//  - The whole track is a big tap target, not just the thumb -- tapping
//    anywhere jumps straight to that value, and dragging from anywhere
//    on the track (not just the thumb) works too.
//  - `touch-action: none` on the track stops the browser from trying to
//    scroll the page while dragging.
//  - The thumb itself is drawn larger than the native default and grows
//    slightly further while actively being dragged, for clear feedback.
//  - Bipolar ranges (min < 0 < max, i.e. the EQ bands) fill from zero
//    instead of from the left edge, matching how EQ sliders read
//    everywhere else (a boosted band fills right, a cut band fills left).
interface SliderProps {
  value: number;
  min: number;
  max: number;
  step?: number;
  accentColor: string;
  onChange: (value: number) => void;
  ariaLabel?: string;
  className?: string;
}

export function Slider({ value, min, max, step = 1, accentColor, onChange, ariaLabel, className }: SliderProps) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);

  const valueFromClientX = useCallback((clientX: number) => {
    const track = trackRef.current;
    if (!track) return value;
    const rect = track.getBoundingClientRect();
    const ratio = rect.width === 0 ? 0 : Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    const raw = min + ratio * (max - min);
    const stepped = Math.round(raw / step) * step;
    return Math.min(max, Math.max(min, stepped));
  }, [min, max, step, value]);

  const handlePointerDown = (e: React.PointerEvent) => {
    e.preventDefault();
    (e.target as Element).setPointerCapture?.(e.pointerId);
    setDragging(true);
    onChange(valueFromClientX(e.clientX));
  };
  const handlePointerMove = (e: React.PointerEvent) => {
    if (!dragging) return;
    onChange(valueFromClientX(e.clientX));
  };
  const endDrag = () => setDragging(false);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    const big = (max - min) >= 20 ? 1 : step; // fine-grained ranges still move by `step` per arrow press
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') { e.preventDefault(); onChange(Math.min(max, value + big)); }
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') { e.preventDefault(); onChange(Math.max(min, value - big)); }
    else if (e.key === 'Home') { e.preventDefault(); onChange(min); }
    else if (e.key === 'End') { e.preventDefault(); onChange(max); }
  };

  const pct = ((value - min) / (max - min)) * 100;
  const zeroPct = min < 0 && max > 0 ? ((0 - min) / (max - min)) * 100 : 0;
  const fillStart = Math.min(zeroPct, pct);
  const fillEnd = Math.max(zeroPct, pct);

  return (
    <div
      ref={trackRef}
      role="slider"
      tabIndex={0}
      aria-label={ariaLabel}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={value}
      className={`relative flex items-center h-8 cursor-pointer select-none ${className ?? ''}`}
      style={{ touchAction: 'none' }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onKeyDown={handleKeyDown}
    >
      {/* Track */}
      <div className="absolute left-0 right-0 h-1.5 rounded-full bg-white/10" />
      {/* Zero tick, bipolar ranges only */}
      {min < 0 && max > 0 && (
        <div className="absolute w-px h-3 bg-white/20" style={{ left: `${zeroPct}%` }} />
      )}
      {/* Fill */}
      <div className="absolute h-1.5 rounded-full" style={{ left: `${fillStart}%`, width: `${fillEnd - fillStart}%`, background: accentColor }} />
      {/* Thumb */}
      <div
        className="absolute rounded-full"
        style={{
          left: `${pct}%`,
          transform: 'translateX(-50%)',
          width: dragging ? 22 : 18,
          height: dragging ? 22 : 18,
          background: accentColor,
          boxShadow: dragging ? '0 2px 8px rgba(0,0,0,0.5)' : '0 1px 4px rgba(0,0,0,0.4)',
          transition: 'width 0.12s ease, height 0.12s ease',
        }}
      />
    </div>
  );
}
