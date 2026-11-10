import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { DesktopHost, DesktopSettingsButton } from '../desktop/DesktopHost';
import { desktopDirty } from '../desktop/bridge';
import { useUIStore } from '../stores/session';
const api = {get_info: vi.fn(), request_exit: vi.fn(), save_preferences: vi.fn(), report_state: vi.fn()};
const info = () => ({ok:true,version:'3.3.0',commit:'abc',mode:'portable',data_dir:'D:/中文数据',signed:false,webview2:'154',active_jobs:0,dirty:false,tray:true,restore:'',settings:{},shutdown:{status:'idle'},update:{status:'idle'}});
beforeEach(() => {
  window.__LZCORE_DESKTOP__={theme:'light',ui:{}};
  Object.assign(window,{pywebview:{api}});
  api.get_info.mockResolvedValue(info()); api.request_exit.mockResolvedValue({ok:true}); api.save_preferences.mockResolvedValue({ok:true}); api.report_state.mockResolvedValue({ok:true});
  useUIStore.setState({theme:'light',themePreference:'system'});
});
afterEach(() => {cleanup(); delete window.__LZCORE_DESKTOP__; vi.clearAllMocks();});
describe('desktop lifecycle UI', () => {
  it('shows first shutdown progress and later failure without a second close click', async () => {
    api.get_info.mockResolvedValue({...info(),shutdown:{status:'stopping'}}); render(<DesktopHost/>);
    window.dispatchEvent(new CustomEvent('lzcore:desktop-action',{detail:{action:'shutdown',shutdown:{status:'stopping'}}}));
    expect(await screen.findByText('正在停止任务并等待收尾…')).toBeVisible();
    expect(screen.getByText('当前没有待处理或运行中的任务。')).toBeVisible();
    api.get_info.mockResolvedValue({...info(),shutdown:{status:'waiting',message:'收尾失败，请核对'}});
    window.dispatchEvent(new CustomEvent('lzcore:desktop-action',{detail:{action:'shutdown',shutdown:{status:'waiting',message:'收尾失败，请核对'}}}));
    expect(await screen.findByText('收尾失败，请核对')).toBeVisible();
    fireEvent.click(screen.getByRole('button',{name:'停止任务并退出'}));
    await waitFor(() => expect(api.request_exit).toHaveBeenCalledWith('exit',false));
  });
  it('keeps desktop-only controls out of the web app', () => {delete window.__LZCORE_DESKTOP__; render(<><DesktopSettingsButton/><DesktopHost/></>); expect(screen.queryByRole('button',{name:'桌面设置'})).toBeNull();});
  it('offers background or explicit shutdown for active tasks', async () => {
    api.get_info.mockResolvedValue({...info(),active_jobs:1}); render(<DesktopHost/>);
    window.dispatchEvent(new CustomEvent('lzcore:desktop-action',{detail:{action:'close'}}));
    await screen.findByRole('button',{name:'后台运行'});
    expect(api.request_exit).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button',{name:'后台运行'}));
    await waitFor(() => expect(api.request_exit).toHaveBeenCalledWith('background'));
  });
  it('requires acknowledgement before discarding dirty edits', async () => {
    api.get_info.mockResolvedValue({...info(),dirty:true}); render(<DesktopHost/>);
    window.dispatchEvent(new CustomEvent('lzcore:desktop-action',{detail:{action:'close'}}));
    const exit = await screen.findByRole('button',{name:'停止任务并退出'});
    expect(exit).toBeDisabled(); fireEvent.click(screen.getByRole('checkbox',{name:'确认放弃未保存的编辑'}));
    expect(exit).not.toBeDisabled(); fireEvent.click(exit);
    await waitFor(() => expect(api.request_exit).toHaveBeenCalledWith('exit',true));
  });
  it('aggregates unsaved state across topology and annotations', async () => {
    desktopDirty('test-topology',true); desktopDirty('test-annotations',true); desktopDirty('test-topology',false);
    expect(api.report_state).toHaveBeenLastCalledWith(expect.objectContaining({dirty:true}));
    desktopDirty('test-annotations',false);
    expect(api.report_state).toHaveBeenLastCalledWith(expect.objectContaining({dirty:false}));
  });
});
