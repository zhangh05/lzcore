/// <reference types="node" />
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const semantic = fs.readFileSync(path.resolve('src/styles/semantic.css'), 'utf8');
const primitives = fs.readFileSync(path.resolve('src/styles/tokens.css'), 'utf8');
const defined = (source: string) => new Set(Array.from(source.matchAll(/(--[a-z][a-z0-9-]*)\s*:/g), match => match[1]));

describe('semantic token layer', () => {
  it('only aliases variables that tokens.css already defines, so it adds no literal colour', () => {
    const known = defined(primitives);
    const references = Array.from(semantic.matchAll(/var\((--[a-z][a-z0-9-]*)/g), match => match[1]);
    expect(references.length).toBeGreaterThan(40);
    expect(references.filter(name => !known.has(name))).toEqual([]);
    expect(semantic.replace(/\/\*[\s\S]*?\*\//g, '')).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(/i);
  });

  it('does not redefine any primitive token', () => {
    const known = defined(primitives);
    expect([...defined(semantic)].filter(name => known.has(name))).toEqual([]);
  });

  it('keeps every semantic name in the --lz- namespace', () => {
    expect([...defined(semantic)].filter(name => !name.startsWith('--lz-'))).toEqual([]);
  });
});
