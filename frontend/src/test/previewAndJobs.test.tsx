import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { fakeBackend } from "./fakeBackend";
import { FilePreview, previewKind } from "../pages/library/FilePreview";
import { JobsColumn } from "../pages/tasks/JobsColumn";

describe("文件预览", () => {
  it("按 mime 选择呈现方式", () => {
    expect(previewKind("image/png")).toBe("image");
    expect(previewKind("audio/mpeg")).toBe("audio");
    expect(previewKind("video/mp4")).toBe("video");
    expect(previewKind("application/pdf")).toBe("pdf");
    expect(previewKind("text/plain")).toBe("text");
    expect(previewKind(undefined)).toBe("text");
  });

  it("图片走 preview 接口；回收站中的媒体不在线预览", () => {
    const { unmount } = render(<FilePreview ws="w 1" fileId="f1" mime="image/png" name="图.png" active />);
    expect(screen.getByRole("img", { name: "图.png" })).toHaveAttribute("src", "/api/storage/files/f1/preview?workspace_id=w%201");
    unmount();
    render(<FilePreview ws="w" fileId="f1" mime="video/mp4" name="v" active={false} />);
    expect(screen.getByTestId("file-preview-unavailable")).toBeInTheDocument();
  });

  it("二进制文本接口结果提示下载，截断时说明只显示部分", async () => {
    fakeBackend((_m, p) => p.startsWith("/api/storage/files/bin/content") ? { status: 200, body: { ok: true, binary: true, content: "" } }
      : p.startsWith("/api/storage/files/txt/content") ? { status: 200, body: { ok: true, content: "abc", truncated: true, total_chars: 99 } } : undefined);
    const { unmount } = render(<FilePreview ws="w" fileId="bin" mime="application/octet-stream" name="x" active />);
    expect(await screen.findByText(/二进制文件/)).toBeInTheDocument();
    unmount();
    render(<FilePreview ws="w" fileId="txt" mime="text/plain" name="t" active />);
    expect(await screen.findByText(/只显示了前 3 个字符（共 99）/)).toBeInTheDocument();
  });
});

describe("作业队列", () => {
  it("显示可读标题与类型，并按状态筛选", async () => {
    fakeBackend((_m, p) => p.startsWith("/api/jobs") ? { status: 200, body: { jobs: [
      { job_id: "job_a", job_type: "workflow_run", title: "Workflow: wf_1", status: "succeeded", created_at: "2026-11-10T01:00:00Z", started_at: "2026-11-10T01:00:00Z", finished_at: "2026-11-10T01:01:05Z" },
      { job_id: "job_b", job_type: "agent_run", status: "failed", error: "provider timeout", created_at: "2026-11-10T02:00:00Z" },
    ] } } : undefined);
    render(<JobsColumn ws="w" />);
    expect(await screen.findByText("工作流 · wf_1")).toBeInTheDocument();
    expect(screen.getByText("用时 1 分 5 秒")).toBeInTheDocument();
    expect(screen.getByText("provider timeout")).toBeInTheDocument();
    fireEvent.click(within(screen.getByRole("group", { name: "按状态筛选作业" })).getByRole("button", { name: /失败/ }));
    expect(screen.queryByText("工作流 · wf_1")).not.toBeInTheDocument();
    expect(screen.getByText("对话回合")).toBeInTheDocument();
  });
});
