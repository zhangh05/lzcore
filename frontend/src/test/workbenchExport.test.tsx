import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { WorkbenchHeader } from '../pages/AgentWorkbench/components/WorkbenchHeader';
import { saveBlob } from '../utils/saveBlob';
import type { ChatMsg } from '../stores/workbench';

const save = vi.fn();
beforeEach(() => {
  window.__LZCORE_DESKTOP__={theme:'light',ui:{}};
  Object.assign(window,{pywebview:{api:{save_file:save}}});
  save.mockResolvedValue({ok:true,path:'D:/中文导出.md'});
});
afterEach(() => { cleanup(); delete window.__LZCORE_DESKTOP__; Object.assign(window,{pywebview:undefined}); vi.resetAllMocks(); });
function header() {
  return render(<WorkbenchHeader sessionTitle="测试会话" currentSessionId="session-test" visibleHistory={[
    {role:'user',text:'中文测试'} as ChatMsg,
  ]} viewMode="chat" onViewModeChange={() => {}} headerCollapsed={false} onToggleHeaderCollapsed={() => {}} llmHealth={{connected:true}}/>);
}
describe('desktop business export', () => {
  it('the actual workbench button opens native save with Unicode content', async () => {
    header();fireEvent.click(screen.getByRole('button',{name:'导出'}));
    await waitFor(() => expect(save).toHaveBeenCalled());
    const [name,encoded,mime]=save.mock.calls[0];
    expect(name).toMatch(/^session-session-.*\.md$/);
    expect(new TextDecoder().decode(Uint8Array.from(atob(encoded), char => char.charCodeAt(0)))).toContain('中文测试');
    expect(mime).toBe('text/markdown');
    await waitFor(() => expect(screen.getByRole('button',{name:'导出'})).toBeEnabled());
  });
  it('shows save failures and does not silently fall back to browser download', async () => {
    save.mockResolvedValue({ok:false,error:'磁盘不可写'});header();
    fireEvent.click(screen.getByRole('button',{name:'导出'}));
    expect(await screen.findByRole('alert')).toHaveTextContent('磁盘不可写');
  });
  it('cancelling native save is a normal outcome', async () => {
    save.mockResolvedValue({ok:false,error:'cancelled'});
    expect(await saveBlob(new Blob(['中文']), '中文.txt')).toBeNull();
  });
  it('waits for native bridge readiness instead of issuing a blocked download', async () => {
    Object.assign(window,{pywebview:undefined});
    await expect(saveBlob(new Blob(['test']),'test.txt')).rejects.toThrow('尚未就绪');
  });
});
