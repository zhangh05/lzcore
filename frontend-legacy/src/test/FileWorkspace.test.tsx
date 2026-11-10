import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from '../router';
import { FileWorkspace } from '../pages/DataCenter/FileWorkspace';
import { knowledgeApi, storageApi } from '../api';
import * as client from '../api/client';
import { confirm } from '../components/ConfirmDialog';
import type { ManagedFile } from '../types';
vi.mock('../components/ConfirmDialog', () => ({ confirm: vi.fn(async () => true) }));
const files = ['first', 'second'].map(id => ({ file_id: id, original_name: id + '.txt', file_kind: 'text', logical_type: 'user_upload', binary: false,
  lifecycle: 'active', size_bytes: 1, source: 'test', mime_type: 'text/plain', created_at: '', sensitivity: 'internal', session_id: '', run_id: '', reference_types: [], metadata: {}, references: [], artifacts: [], reference_count: id === 'first' ? 1 : 0 }) as ManagedFile);
beforeEach(() => {
  vi.spyOn(storageApi, 'page').mockResolvedValue({ ok: true, files, total: 2, next_cursor: '' });
  vi.spyOn(storageApi, 'events').mockReturnValue({ addEventListener: vi.fn(), close: vi.fn() } as unknown as EventSource);
  vi.spyOn(storageApi, 'metadata').mockImplementation(async (_ws, id) => ({ ok: true, file: files.find(file => file.file_id === id)! }));
});
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); });
const mount = () => render(<MemoryRouter><FileWorkspace workspaceId="default" /></MemoryRouter>);

describe('file workspace', () => {
  it('uses the managed identity when importing knowledge, preserving the original', async () => {
    vi.spyOn(storageApi, 'content').mockResolvedValue({ ok: true, file_id: 'first', binary: false, content: 'source', truncated: false });
    const upload = vi.spyOn(knowledgeApi, 'upload').mockRejectedValue(new Error('unsupported parsing, original preserved'));
    mount(); fireEvent.click(await screen.findByRole('button', { name: /first.txt/ }));
    fireEvent.click(screen.getByRole('button', { name: '加入知识库' }));
    await screen.findByText('unsupported parsing, original preserved');
    expect(upload).toHaveBeenCalledWith('default', { file_id: 'first' }, { title: 'first.txt' });
    expect(screen.getByRole('link', { name: '下载原件' })).toBeVisible();
  });
  it('shows actual batch failures, preserves failed selection and confirms dependency impact', async () => {
    vi.spyOn(storageApi, 'delete').mockImplementation(async (_ws, id) => {
      if (id === 'second') throw new Error('second cannot be recycled');
      return { ok: true, file_id: id, lifecycle: 'soft_deleted', recoverable: true };
    });
    mount(); await screen.findByRole('checkbox', { name: '选择 first.txt' });
    fireEvent.click(screen.getByRole('checkbox', { name: '选择 first.txt' }));
    fireEvent.click(screen.getByRole('checkbox', { name: '选择 second.txt' }));
    fireEvent.click(screen.getByRole('button', { name: '处理已选 2 项' }));
    await screen.findByText('second.txt：second cannot be recycled');
    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ body: expect.stringContaining('涉及 1 处使用关系') }));
    expect(screen.getByRole('checkbox', { name: '选择 first.txt' })).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: '选择 second.txt' })).toBeChecked();
  });
  it('discards a late continuation belonging to a previously selected file', async () => {
    vi.spyOn(storageApi, 'content').mockImplementation(async (_ws, id) => ({ ok: true, file_id: id, binary: false, content: id + ' body', truncated: id === 'first', next_offset: id === 'first' ? 10 : null }));
    let release!: (value: unknown) => void;
    vi.spyOn(client, 'apiRequest').mockImplementation(() => new Promise(resolve => { release = resolve as (value: unknown) => void; }));
    mount(); fireEvent.click(await screen.findByRole('button', { name: /first.txt/ }));
    fireEvent.click(await screen.findByRole('button', { name: '继续读取' }));
    fireEvent.click(screen.getByRole('button', { name: /second.txt/ }));
    await waitFor(() => expect(screen.getByText('second body')).toBeTruthy());
    await act(async () => release({ content: 'first tail', next_offset: null }));
    expect(screen.queryByText(/first tail/)).toBeNull();
    expect(screen.getByText('second body')).toBeTruthy();
  });
});
