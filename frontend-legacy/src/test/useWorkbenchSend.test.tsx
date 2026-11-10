import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useWorkbenchSend, type PendingAttachment } from "../hooks/useWorkbenchSend";
import * as apiClient from "../api/client";

const sendStream = vi.fn();
vi.mock("../hooks/useChatStream", () => ({
  useChatStream: () => ({ send: sendStream, stop: vi.fn() }),
}));

describe("useWorkbenchSend", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    sendStream.mockReset();
  });

  it("retains the draft, metadata, and attachment when every upload fails", async () => {
    vi.spyOn(apiClient, "apiRequest").mockRejectedValue(new Error("upload failed"));
    const attachment: PendingAttachment = {
      id: "attachment-1",
      name: "evidence.txt",
      size: "4 B",
      file: new File(["data"], "evidence.txt", { type: "text/plain" }),
    };
    const setInput = vi.fn();
    const setAttachments = vi.fn();
    const clearDraft = vi.fn();
    const pendingAutoMetadataRef = { current: { source: "retry-me" } };
    const toast = vi.fn();
    const { result } = renderHook(() => useWorkbenchSend({
      workspaceId: "default",
      sessionId: "session-1",
      input: "keep this draft",
      attachments: [attachment],
      sending: false,
      setInput,
      setAttachments,
      clearDraft,
      prepareToSend: vi.fn(),
      keepAtBottom: vi.fn(),
      toast,
      pendingAutoMetadataRef,
    }));

    await act(async () => { await result.current.send(); });

    expect(setInput).not.toHaveBeenCalled();
    expect(clearDraft).not.toHaveBeenCalled();
    expect(pendingAutoMetadataRef.current).toEqual({ source: "retry-me" });
    expect(sendStream).not.toHaveBeenCalled();
    const finalUpdater = setAttachments.mock.calls.at(-1)?.[0] as (items: PendingAttachment[]) => PendingAttachment[];
    expect(finalUpdater([attachment])).toEqual([{ ...attachment, uploading: false }]);
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: "附件上传失败" }));
  });

  it("sends uploaded attachments and retains only the failed items", async () => {
    vi.spyOn(apiClient, "apiRequest")
      .mockResolvedValueOnce({ ok: true, file: { file_id: "file-success" } })
      .mockRejectedValueOnce(new Error("upload failed"));
    const uploaded: PendingAttachment = {
      id: "attachment-ok", name: "ok.txt", size: "2 B",
      file: new File(["ok"], "ok.txt", { type: "text/plain" }),
    };
    const failed: PendingAttachment = {
      id: "attachment-failed", name: "failed.txt", size: "3 B",
      file: new File(["bad"], "failed.txt", { type: "text/plain" }),
    };
    const setAttachments = vi.fn();
    const setInput = vi.fn();
    const clearDraft = vi.fn();
    const pendingAutoMetadataRef = { current: { source: "one-shot" } };
    const { result } = renderHook(() => useWorkbenchSend({
      workspaceId: "default", sessionId: "session-1", input: "send available",
      attachments: [uploaded, failed], sending: false, setInput, setAttachments,
      clearDraft, prepareToSend: vi.fn(), keepAtBottom: vi.fn(), toast: vi.fn(),
      pendingAutoMetadataRef,
    }));

    await act(async () => { await result.current.send(); });

    const finalUpdater = setAttachments.mock.calls.at(-1)?.[0] as (items: PendingAttachment[]) => PendingAttachment[];
    expect(finalUpdater([uploaded, failed])).toEqual([{ ...failed, uploading: false }]);
    expect(setInput).toHaveBeenCalledWith("");
    expect(clearDraft).toHaveBeenCalledOnce();
    expect(pendingAutoMetadataRef.current).toBeNull();
    expect(sendStream).toHaveBeenCalledWith(expect.objectContaining({
      attachments: [expect.objectContaining({ file_id: "file-success", name: "ok.txt" })],
    }));
  });
});

it('reuses an existing managed file without uploading and uses current server metadata', async () => {
  const request = vi.spyOn(apiClient, 'apiRequest').mockResolvedValue({ ok: true, file: { file_id: 'file-existing', lifecycle: 'active', original_name: '原件.pdf', mime_type: 'application/pdf', size_bytes: 42 } });
  const { result } = renderHook(() => useWorkbenchSend({ workspaceId: 'default', sessionId: 'session-2', input: 'use again',
    attachments: [{ id: 'existing', name: 'old name', size: '1 B', managed: { file_id: 'file-existing', workspace_id: 'default', mime_type: 'application/pdf', size_bytes: 1 } }], sending: false,
    setInput: vi.fn(), setAttachments: vi.fn(), clearDraft: vi.fn(), prepareToSend: vi.fn(), keepAtBottom: vi.fn(), toast: vi.fn(), pendingAutoMetadataRef: { current: null } }));
  await act(async () => { await result.current.send(); });
  expect(request).toHaveBeenCalledWith(expect.objectContaining({ method: 'GET', url: '/storage/files/file-existing', params: { workspace_id: 'default' } }));
  expect(request.mock.calls.every(([config]) => config.method !== 'POST')).toBe(true);
  expect(sendStream).toHaveBeenCalledWith(expect.objectContaining({ attachments: [expect.objectContaining({ file_id: 'file-existing', name: '原件.pdf' })] }));
});

it('retains an attachment selected in a different workspace', async () => {
  sendStream.mockReset();
  const request = vi.spyOn(apiClient, 'apiRequest');
  const { result } = renderHook(() => useWorkbenchSend({ workspaceId: 'current', sessionId: 'session-2', input: '',
    attachments: [{ id: 'existing', name: 'other.pdf', size: '1 B', managed: { file_id: 'file-existing', workspace_id: 'other', mime_type: 'application/pdf', size_bytes: 1 } }], sending: false,
    setInput: vi.fn(), setAttachments: vi.fn(), clearDraft: vi.fn(), prepareToSend: vi.fn(), keepAtBottom: vi.fn(), toast: vi.fn(), pendingAutoMetadataRef: { current: null } }));
  await act(async () => { await result.current.send(); });
  expect(request).not.toHaveBeenCalled();
  expect(sendStream).not.toHaveBeenCalled();
});
