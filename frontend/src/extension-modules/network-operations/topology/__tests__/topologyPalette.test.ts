/// <reference types="node" />
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { NODE_STATUS_COLORS, NODE_STATUS_COLORS_DARK, CANVAS_ACCENT, CANVAS_GROUP } from '../components/topologyPalette';

/**
 * Canvas colours must equal what the CSS tokens resolve to. Tokens alias the Arc
 * foundation (unlayered, so it wins name clashes), which defines oklch values;
 * the canvas needs sRGB hex, so the test resolves the var() chain and converts.
 */
const read = (p: string) => fs.readFileSync(path.resolve(p), 'utf8');
const foundation = read('src/components/arc/foundation.css');
const tokens = read('src/styles/tokens.css');

function decls(css: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of css.matchAll(/--([a-z0-9-]+):\s*([^;]+);/g)) out[m[1]] ??= m[2].trim();
  return out;
}
function block(css: string, selector: string): string {
  const start = css.indexOf(selector);
  if (start < 0) return '';
  return css.slice(start, css.indexOf('\n}', start));
}

const arcLight = decls(block(foundation, ':root {'));
const arcDark = decls(block(foundation, ':root[data-theme="dark"] {'));
const darkStart = tokens.indexOf('[data-theme="dark"] {\n  color-scheme: dark;');
const tokLight = decls(tokens.slice(0, darkStart) + tokens.slice(tokens.indexOf('\n}\n', darkStart)));
const tokDark = decls(block(tokens, '[data-theme="dark"] {\n  color-scheme: dark;'));
// The product accent is chosen on <html data-accent>; resolve it the same way the browser does.
const accentName = read('index.html').match(/data-accent="([a-z]+)"/)?.[1] ?? 'neutral';
const accentLight = decls(block(foundation, `:root[data-accent="${accentName}"] {`));
const accentDark = decls(block(foundation, `:root[data-theme="dark"][data-accent="${accentName}"] {`));
const themes = {
  light: { ...tokLight, ...arcLight, ...accentLight },
  dark: { ...tokLight, ...arcLight, ...tokDark, ...arcDark, ...accentLight, ...accentDark },
};

function resolve(defs: Record<string, string>, name: string, depth = 0): string {
  const v = defs[name];
  if (v === undefined || depth > 12) throw new Error(`unresolved --${name}`);
  const ref = v.match(/^var\(--([a-z0-9-]+)\)$/);
  return ref ? resolve(defs, ref[1], depth + 1) : v;
}

function oklchToHex(value: string): string {
  const m = value.match(/^oklch\(\s*([\d.]+)(%?)\s+([\d.]+)\s+([\d.]+)\s*\)$/);
  if (!m) throw new Error(`not an oklch colour: ${value}`);
  const L = m[2] ? Number(m[1]) / 100 : Number(m[1]);
  const C = Number(m[3]);
  const h = (Number(m[4]) * Math.PI) / 180;
  const a = C * Math.cos(h), b = C * Math.sin(h);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const mm = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const rgb = [
    4.0767416621 * l - 3.3077115913 * mm + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * mm - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * mm + 1.707614701 * s,
  ];
  const gamma = (x: number) => { const c = Math.min(1, Math.max(0, x)); return c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055; };
  return `#${rgb.map((x) => Math.round(gamma(x) * 255).toString(16).padStart(2, '0')).join('')}`;
}

const toHex = (value: string) => (/^#[0-9a-f]{6}$/i.test(value) ? value.toLowerCase() : oklchToHex(value));
const token = (theme: keyof typeof themes, name: string) => toHex(resolve(themes[theme], name));

describe('CSS/canvas semantic colour contract', () => {
  for (const [theme, palette] of [['light', NODE_STATUS_COLORS], ['dark', NODE_STATUS_COLORS_DARK]] as const) {
    it(`keeps ${theme} canvas states, interaction and neutral groups aligned with CSS`, () => {
      for (const [state, name] of [['ok', 'ok'], ['warning', 'warn'], ['error', 'danger'], ['unknown', 'unknown']] as const) {
        expect(palette[state]).toBe(token(theme, name));
      }
      expect(CANVAS_ACCENT[theme]).toBe(token(theme, 'accent'));
      expect(CANVAS_GROUP[theme].fill).toBe(token(theme, 'surface-2'));
      expect(CANVAS_GROUP[theme].border).toBe(token(theme, 'line'));
      expect(CANVAS_GROUP[theme].text).toBe(token(theme, 'text-3'));
    });
  }
});
