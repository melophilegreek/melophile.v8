// The app's accent color is user-customizable (picked from presets or a raw
// hex input), and used as a solid background behind icons/text in a bunch of
// places (play button, "Done", queue badge, etc). Those all used to hardcode
// black text/icons, which reads fine on the old Spotify-green default but
// goes low-contrast-and-muddy on darker accents like blue or purple presets
// (sapphire blue, for one, is well under the WCAG AA 4.5:1 threshold against
// black -- see the contrast math below). Rather than hardcode a color per
// accent, compute which of black/white actually reads better against
// *whatever* color is currently selected.
export function getContrastText(hex: string): '#000000' | '#ffffff' {
  const h = hex.replace('#', '');
  if (h.length !== 6) return '#000000';
  const r = parseInt(h.slice(0, 2), 16) / 255;
  const g = parseInt(h.slice(2, 4), 16) / 255;
  const b = parseInt(h.slice(4, 6), 16) / 255;
  const chan = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  // Relative luminance per WCAG 2.x -- standard sRGB -> luminance formula.
  const luminance = 0.2126 * chan(r) + 0.7152 * chan(g) + 0.0722 * chan(b);
  // Contrast ratio of this color against pure black vs pure white; whichever
  // is higher is the more readable choice for text/icons drawn on top of it.
  const contrastWithBlack = (luminance + 0.05) / 0.05;
  const contrastWithWhite = 1.05 / (luminance + 0.05);
  return contrastWithBlack >= contrastWithWhite ? '#000000' : '#ffffff';
}

// Feature (custom color picker): mobile browsers render the native
// <input type="color"> picker very inconsistently — some (like Android
// WebView / Samsung Internet) fall back to a plain swatch-grid dialog
// instead of the gradient saturation/value + hue picker Chrome desktop
// shows. These conversions back a custom-drawn picker (see
// CustomColorPicker.tsx) so the picker UI is identical on every device.

/** hex (#rrggbb) -> { h: 0-360, s: 0-1, v: 0-1 } */
export function hexToHsv(hex: string): { h: number; s: number; v: number } {
  const clean = hex.replace('#', '');
  const valid = /^[0-9a-fA-F]{6}$/.test(clean) ? clean : '1db954';
  const r = parseInt(valid.slice(0, 2), 16) / 255;
  const g = parseInt(valid.slice(2, 4), 16) / 255;
  const b = parseInt(valid.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;

  let h = 0;
  if (delta !== 0) {
    if (max === r) h = 60 * (((g - b) / delta) % 6);
    else if (max === g) h = 60 * ((b - r) / delta + 2);
    else h = 60 * ((r - g) / delta + 4);
  }
  if (h < 0) h += 360;

  const s = max === 0 ? 0 : delta / max;
  const v = max;
  return { h, s, v };
}

/** { h: 0-360, s: 0-1, v: 0-1 } -> hex (#rrggbb) */
export function hsvToHex(h: number, s: number, v: number): string {
  const c = v * s;
  const hh = (((h % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hh % 2) - 1));
  let r = 0, g = 0, b = 0;
  if (hh < 1) { r = c; g = x; b = 0; }
  else if (hh < 2) { r = x; g = c; b = 0; }
  else if (hh < 3) { r = 0; g = c; b = x; }
  else if (hh < 4) { r = 0; g = x; b = c; }
  else if (hh < 5) { r = x; g = 0; b = c; }
  else { r = c; g = 0; b = x; }
  const m = v - c;
  const toHex = (n: number) => Math.round((n + m) * 255).toString(16).padStart(2, '0');
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}
