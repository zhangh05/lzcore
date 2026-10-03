import { describe, expect, it } from 'vitest';
import { DRAWING_DEFAULTS, linkDrawingAppearance, drawingContrastUnderlay, drawingColorHex } from '../../../extensions/network_operations/frontend/components/topologyDrawingAppearance';
import { exportTopologyToSvg } from '../../../extensions/network_operations/frontend/components/topologyExport';

describe('drawing appearance independent of runtime evidence', () => {
  it('keeps all declared statuses neutral without mutating stored style', () => {
    for (const status of ['up', 'down', 'unknown'] as const) {
      const link = { status, style: undefined };
      expect(linkDrawingAppearance(link).color).toBe(DRAWING_DEFAULTS.link);
      expect(link.style).toBeUndefined();
    }
  });
  it('preserves explicit blue, purple and black independent of declared status', () => {
    for (const color of ['#000000', '#1262aa', '#8b5cf6']) {
      expect(linkDrawingAppearance({ status: 'down', style: { color } })).toMatchObject({ color, source: 'custom' });
    }
    expect(linkDrawingAppearance({ style: { color: '#12' } })).toMatchObject({ color: DRAWING_DEFAULTS.link, source: 'default' });
    expect(drawingColorHex('#abc')).toBe('#aabbcc');
  });
  it('enhances only insufficient contrast without replacing the core colour', () => {
    expect(drawingContrastUnderlay('#000000', false).opacity).toBe(0);
    expect(drawingContrastUnderlay('#000000', true).opacity).toBeGreaterThan(0);
    expect(drawingContrastUnderlay('#ffffff', false).opacity).toBeGreaterThan(0);
    for (const dark of [false, true]) expect(drawingContrastUnderlay(DRAWING_DEFAULTS.link, dark).opacity).toBe(0);
  });
  it('exports neutral borders and original colours and line styles without view-only markings', () => {
    const svg = exportTopologyToSvg({ topology_id: 'drawing', name: 'Test', description: '', version: 1, created_at: '', updated_at: '', nodes: [
      { node_id: 'a', x: 0, y: 0 }, { node_id: 'b', x: 100, y: 0 },
    ], links: [{ link_id: 'l', source_node_id: 'a', target_node_id: 'b', source_interface: '', target_interface: '', kind: 'physical', source: 'manual', status: 'down', style: { color: '#000000', line_style: 'solid', width: 6 } }], groups: [], canvas_items: [] });
    expect(svg).toContain(`stroke="${DRAWING_DEFAULTS.nodeBorder}"`);
    expect(svg).toMatch(/<line[^>]+stroke="#000000"[^>]+stroke-width="6"/);
    expect(svg).not.toContain('stroke-dasharray');
    expect(svg).not.toContain('underlay');
  });
});
