import { expect, it, vi } from 'vitest';
import { render, fireEvent, screen } from '@testing-library/react';
import { LinkColorControl } from '../../../extensions/network_operations/frontend/components/LinkColorControl';
import type { TopologyLink } from '../../../extensions/network_operations/frontend/components/TopologyWorkspace';
const link: TopologyLink = { link_id: 'l', source_node_id: 'a', target_node_id: 'b', source_interface: '', target_interface: '', kind: 'physical', status: 'unknown', source: 'manual' };
it('shows effective neutral colour and does not persist untouched controls or incomplete drafts', () => {
  const change = vi.fn();
  render(<LinkColorControl link={link} onChange={change} />);
  expect(screen.getByLabelText('自定义拾色器')).toHaveValue('#66717a');
  const input = screen.getByLabelText('连线 Hex 颜色');
  fireEvent.blur(input);
  expect(change).not.toHaveBeenCalled();
  fireEvent.change(input, { target: { value: '#0' } }); fireEvent.blur(input);
  expect(screen.getByRole('alert')).toBeVisible();
  expect(change).not.toHaveBeenCalled();
  fireEvent.change(input, { target: { value: '#000000' } }); fireEvent.keyDown(input, { key: 'Enter' });
  expect(change).toHaveBeenLastCalledWith('#000000');
});
it('resets only colour and exposes actual custom colour', () => {
  const change = vi.fn();
  render(<LinkColorControl link={{ ...link, style: { color: '#1262aa', width: 6 } }} onChange={change} />);
  expect(screen.getByTestId('link-color-source')).toHaveTextContent('自定义 · #1262aa');
  fireEvent.click(screen.getByRole('button', { name: '恢复默认颜色' }));
  expect(change).toHaveBeenCalledWith(undefined);
});
