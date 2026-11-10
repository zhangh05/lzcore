import { describe, expect, it } from 'vitest';
import { overlayObservationStatus, overlayCanvasLine, overlayCaption, type NodeOverlay } from '../../../extensions/network_operations/frontend/components/nodeOverlay';
const bound: NodeOverlay = {
  node_id: 'pe1', device_id: 'device_1', device_state: 'bound', device: { name: 'PE1' },
  connection: { status: 'connected', last_tested_at: '2026-09-23T01:00:00Z' },
  observation: { observed_at: '2026-09-23T02:00:00Z', completeness: 'partial' },
};
describe('recent evidence markers', () => {
  it('keeps absent or untested evidence neutral', () => {
    expect(overlayObservationStatus(undefined)).toBeNull();
    expect(overlayObservationStatus({ ...bound, connection: null, observation: null })).toBeNull();
    expect(overlayObservationStatus({ ...bound, connection: { status: 'untested', last_tested_at: '' }, observation: null })).toBeNull();
  });
  it('uses latest evidence, distinguishing successful tests from current health', () => {
    expect(overlayObservationStatus(bound)).toBe('warning');
    expect(overlayCanvasLine(bound)).toContain('观测部分');
    const test = { ...bound, observation: null };
    expect(overlayObservationStatus(test)).toBe('ok');
    expect(overlayCaption(test)).toContain('最近连接成功');
    expect(overlayCaption(test)).toContain('不表示当前健康');
    expect(overlayObservationStatus({ ...bound, connection: { status: 'failed', last_tested_at: '2026-09-23T03:00:00Z' } })).toBe('error');
    expect(overlayObservationStatus({ ...test, device_state: 'missing', device: null })).toBe('warning');
    expect(overlayCaption({ ...test, device_state: 'missing', device: null })).toContain('不代表设备故障');
  });
  it('reserves unknown for an evidenced inconclusive result', () => {
    expect(overlayObservationStatus({ ...bound, observation: { observed_at: '2026-09-23T02:00:00Z', completeness: 'unknown' } })).toBe('unknown');
    expect(overlayObservationStatus({ ...bound, observation: null, connection: { status: 'unknown', last_tested_at: '' } })).toBeNull();
    expect(overlayObservationStatus({ ...bound, observation: null, connection: { status: 'unknown', last_tested_at: '2026-09-23T03:00:00Z' } })).toBe('unknown');
  });
});
