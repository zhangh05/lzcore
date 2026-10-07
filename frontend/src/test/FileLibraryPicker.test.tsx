import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { FileLibraryPicker } from '../components/FileLibraryPicker';
import { storageApi } from '../api';
import type { ManagedFile } from '../types';

const file = (id: string) => ({ file_id: id, original_name: id + '.pdf', file_kind: 'pdf', size_bytes: 3 } as ManagedFile);
describe('existing-file picker', () => {
  it('limits selection and resets it when the workspace changes', async () => {
    vi.spyOn(storageApi, 'page').mockImplementation(async ws => ({ ok: true, files: [file(ws + '-a'), file(ws + '-b')], total: 2, next_cursor: '' }));
    const choose = vi.fn();
    const view = render(<FileLibraryPicker workspaceId="first" maxCount={1} open onClose={vi.fn()} onChoose={choose} />);
    await waitFor(() => expect(screen.getByText('first-a.pdf')).toBeTruthy());
    fireEvent.click(screen.getAllByRole('checkbox')[0]);
    expect(screen.getAllByRole('checkbox')[1]).toBeDisabled();
    view.rerender(<FileLibraryPicker workspaceId="second" maxCount={1} open onClose={vi.fn()} onChoose={choose} />);
    await waitFor(() => expect(screen.getByText('second-a.pdf')).toBeTruthy());
    expect(screen.getByRole('button', { name: '添加 0 个文件' })).toBeDisabled();
    fireEvent.click(screen.getAllByRole('checkbox')[0]);
    fireEvent.click(screen.getByRole('button', { name: '添加 1 个文件' }));
    expect(choose).toHaveBeenCalledWith([expect.objectContaining({ file_id: 'second-a' })]);
    view.unmount(); vi.restoreAllMocks();
  });
});
