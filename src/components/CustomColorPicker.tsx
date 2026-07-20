import { useCallback, useEffect, useRef, useState } from 'react';
import { hexToHsv, hsvToHex } from '../lib/color';

// Fix (native color picker inconsistent on mobile): <input type="color">
// hands rendering off to the OS/browser, and some mobile browsers (e.g.
// Android WebView, Samsung Internet) fall back to a plain 8-swatch grid
// dialog instead of a proper gradient picker -- a very different, more
// limited experience than Chrome desktop's gradient square + hue bar.
// This draws that same gradient square + hue bar ourselves with CSS, so
// every platform gets the identical picker.
interface Props {
  color: string;
  onChange: (hex: string) => void;
}

export function CustomColorPicker({ color, onChange }: Props) {
  const [hsv, setHsv] = useState(() => hexToHsv(color));
  const svRef = useRef<HTMLDivElement>(null);
  const hueRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef<'sv' | 'hue' | null>(null);

  // Stay in sync if the color changes from elsewhere (a preset tap, hex
  // input, etc) -- but not while this picker itself is mid-drag, since our
  // own onChange -> prop round-trip through hex can lose a hair of
  // precision and would otherwise fight the finger currently dragging.
  useEffect(() => {
    if (draggingRef.current) return;
    setHsv(hexToHsv(color));
  }, [color]);

  const updateSV = useCallback((clientX: number, clientY: number) => {
    const el = svRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const x = Math.min(Math.max(clientX - rect.left, 0), rect.width);
    const y = Math.min(Math.max(clientY - rect.top, 0), rect.height);
    const s = rect.width === 0 ? 0 : x / rect.width;
    const v = rect.height === 0 ? 0 : 1 - y / rect.height;
    setHsv((prev) => {
      const next = { ...prev, s, v };
      onChange(hsvToHex(next.h, next.s, next.v));
      return next;
    });
  }, [onChange]);

  const updateHue = useCallback((clientX: number) => {
    const el = hueRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const x = Math.min(Math.max(clientX - rect.left, 0), rect.width);
    const h = rect.width === 0 ? 0 : (x / rect.width) * 360;
    setHsv((prev) => {
      const next = { ...prev, h };
      onChange(hsvToHex(next.h, next.s, next.v));
      return next;
    });
  }, [onChange]);

  useEffect(() => {
    const handleMove = (e: PointerEvent) => {
      if (draggingRef.current === 'sv') updateSV(e.clientX, e.clientY);
      else if (draggingRef.current === 'hue') updateHue(e.clientX);
    };
    const handleUp = () => { draggingRef.current = null; };
    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleUp);
    window.addEventListener('pointercancel', handleUp);
    return () => {
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleUp);
      window.removeEventListener('pointercancel', handleUp);
    };
  }, [updateSV, updateHue]);

  const hueColor = hsvToHex(hsv.h, 1, 1);

  return (
    <div className="select-none">
      {/* Saturation / value square */}
      <div
        ref={svRef}
        className="relative w-full h-36 rounded-xl cursor-pointer overflow-hidden"
        style={{
          touchAction: 'none',
          backgroundImage: 'linear-gradient(to top, #000, rgba(0,0,0,0)), linear-gradient(to right, #fff, rgba(255,255,255,0))',
          backgroundColor: hueColor,
        }}
        onPointerDown={(e) => {
          e.preventDefault();
          draggingRef.current = 'sv';
          (e.target as Element).setPointerCapture?.(e.pointerId);
          updateSV(e.clientX, e.clientY);
        }}
      >
        <div
          className="absolute w-5 h-5 rounded-full border-2 border-white pointer-events-none"
          style={{
            left: `${hsv.s * 100}%`,
            top: `${(1 - hsv.v) * 100}%`,
            transform: 'translate(-50%, -50%)',
            boxShadow: '0 0 0 1px rgba(0,0,0,0.5), 0 1px 4px rgba(0,0,0,0.4)',
          }}
        />
      </div>

      {/* Hue bar */}
      <div
        ref={hueRef}
        className="relative w-full h-4 rounded-full mt-3 cursor-pointer"
        style={{
          touchAction: 'none',
          backgroundImage: 'linear-gradient(to right, #f00, #ff0, #0f0, #0ff, #00f, #f0f, #f00)',
        }}
        onPointerDown={(e) => {
          e.preventDefault();
          draggingRef.current = 'hue';
          (e.target as Element).setPointerCapture?.(e.pointerId);
          updateHue(e.clientX);
        }}
      >
        <div
          className="absolute top-1/2 w-5 h-5 rounded-full border-2 border-white pointer-events-none"
          style={{
            left: `${(hsv.h / 360) * 100}%`,
            transform: 'translate(-50%, -50%)',
            background: hueColor,
            boxShadow: '0 0 0 1px rgba(0,0,0,0.5), 0 1px 4px rgba(0,0,0,0.4)',
          }}
        />
      </div>
    </div>
  );
}
