/// <reference types="node" />
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { NODE_STATUS_COLORS, NODE_STATUS_COLORS_DARK, CANVAS_ACCENT, CANVAS_GROUP } from '../../../extensions/network_operations/frontend/components/topologyPalette';

const source = fs.readFileSync(path.resolve('src/styles/tokens.css'), 'utf8');
const dark = source.slice(source.indexOf('[data-theme="dark"] {\n  color-scheme: dark;'));
const token = (text: string, name: string) => text.match(new RegExp(`--${name}: (#[a-f0-9]+);`))![1];

describe('CSS/canvas semantic colour contract', () => {
  for (const [theme, css, palette] of [['light', source, NODE_STATUS_COLORS], ['dark', dark, NODE_STATUS_COLORS_DARK]] as const) {
    it(`keeps ${theme} canvas states, interaction and neutral groups aligned with CSS`, () => {
      for (const [state, name] of [['ok','ok'], ['warning','warn'], ['error','danger'], ['unknown','unknown']] as const) {
        expect(palette[state]).toBe(token(css, name));
      }
      expect(CANVAS_ACCENT[theme]).toBe(token(css, 'accent'));
      expect(CANVAS_GROUP[theme].fill).toBe(token(css, 'surface-2'));
      expect(CANVAS_GROUP[theme].text).toBe(token(css, 'text-3'));
    });
  }
});
