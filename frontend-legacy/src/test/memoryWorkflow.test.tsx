import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryPage } from "../pages/MemoryPage/MemoryPage";
import { memoryApi } from "../api";
import { enqueue, enqueueAsync, getRequests, installMockApi, resetMocks } from "./mockServer";
import { useSessionStore } from "../stores/session";

const entry = { memory_id: "mem-123456abcdef", title: "发布约定", summary: "发布约定", content: "以后默认自动推送提交",
  status: "active", memory_type: "core_rule", scope: "workspace", workspace_id: "project-a", metadata: {memory_key: "release.policy"} };
const list = (records: unknown[], extra = {}) => ({ status: 200, data: { ok: true, records, ...extra } });
describe("memory workflow", () => {
  beforeEach(() => { resetMocks(); installMockApi(); useSessionStore.setState({ currentWorkspaceId: "project-a" }); });

  it("saves complete content in an explicitly selected personal scope", async () => {
    enqueue("/memory/list", list([])); enqueue("/memory/list", list([]));
    enqueue("/memory/write", {status:200, data:{ok:true, memory_id:"created", status:"active"}});
    const user=userEvent.setup(); render(<MemoryPage />);
    await screen.findByText("暂无记忆"); await user.click(screen.getByRole("button", {name:"新建"}));
    await user.selectOptions(screen.getByLabelText("生效范围"), "global");
    await user.selectOptions(screen.getByLabelText("记忆分类"), "core_rule");
    await user.type(screen.getByLabelText("记忆标题"), "完整偏好");
    const content="完整正文".repeat(1000)+"末尾约束";
    // Pasting avoids 4,000 keystrokes; the production textarea remains uncapped.
    screen.getByLabelText("记忆内容").focus(); await user.paste(content);
    await user.click(screen.getByRole("button", {name:"保存"}));
    await screen.findByText("记忆已保存");
    const write=getRequests().find(r=>r.url==="/memory/write")!.data;
    expect(write).toMatchObject({content, scope:"global", memory_type:"core_rule", workspace_id:"project-a"});
    expect(write.memory_id).toMatch(/^mem-[a-f0-9]{12}$/);
  });

  it("edits the exact record as a reviewable new version", async () => {
    enqueue("/memory/list", list([entry])); enqueue("/memory/list", list([]));
    enqueue("/memory/write", {status:200,data:{ok:true,memory_id:"new-version",status:"active"}});
    const user=userEvent.setup(); render(<MemoryPage />);
    await user.click(await screen.findByRole("button",{name:"发布约定"}));
    await user.click(screen.getByRole("button",{name:"修改记忆"}));
    await user.clear(screen.getByLabelText("记忆内容")); await user.type(screen.getByLabelText("记忆内容"),"以后不要自动推送提交");
    await user.click(screen.getByRole("button",{name:"保存"}));
    await screen.findByText("已替换原记忆，旧版本保留在历史中");
    expect(getRequests().find(r=>r.url==="/memory/write")!.data).toMatchObject({
      supersedes_memory_id:entry.memory_id, content:"以后不要自动推送提交", scope:"workspace", memory_type:"core_rule", memory_key:"release.policy"});
  });

  it("ignores a delayed response from a previous project", async () => {
    let resolve!: (value: ReturnType<typeof list>) => void;
    enqueueAsync("/memory/list", new Promise(r=>{resolve=r;}));
    enqueue("/memory/list", list([{...entry,title:"新项目规则",summary:"新项目规则"}]));
    render(<MemoryPage />);
    await waitFor(()=>expect(getRequests().length).toBe(1));
    act(()=>useSessionStore.setState({currentWorkspaceId:"project-b"}));
    await screen.findByRole("button",{name:"新项目规则"});
    await act(async()=>resolve(list([entry])));
    expect(screen.queryByRole("button",{name:"发布约定"})).not.toBeInTheDocument();
  });

  it("paginates and retains controls when a filter has no matches", async () => {
    enqueue("/memory/list", list([entry],{total:2,next_offset:100}));
    enqueue("/memory/list", list([{...entry,memory_id:"mem-abcdef123456",title:"后续规则",summary:"后续规则"}],{total:2,next_offset:null}));
    enqueue("/memory/list", list([],{total:0}));
    const user=userEvent.setup(); render(<MemoryPage />);
    await user.click(await screen.findByRole("button",{name:"加载更多"}));
    await screen.findByRole("button",{name:"后续规则"});
    expect(getRequests()[1].params.offset).toBe(100);
    await user.selectOptions(screen.getByLabelText("筛选范围"),"global");
    await screen.findByText("没有匹配的记忆");
    expect(screen.getByLabelText("筛选范围")).toBeVisible();
    expect(getRequests()[2].params).toMatchObject({scope:"global",offset:0});
  });

  it("reconciles an unknown save with reads without another write", async () => {
    enqueue("/memory/list", list([])); enqueue("/memory/list", list([]));
    enqueue("/memory/write",{status:500,data:{error:"response lost"}});
    const get=vi.spyOn(memoryApi,"get").mockRejectedValueOnce(new Error("unconfirmed"));
    const user=userEvent.setup(); render(<MemoryPage />);
    await screen.findByText("暂无记忆"); await user.click(screen.getByRole("button",{name:"新建"}));
    await user.type(screen.getByLabelText("记忆标题"),"偏好"); await user.type(screen.getByLabelText("记忆内容"),"完整偏好内容");
    await user.click(screen.getByRole("button",{name:"保存"}));
    await screen.findByText(/尚未查到可确认的原记录/);
    expect(screen.getByRole("button",{name:"保存"})).toBeDisabled();
    const id=getRequests().find(r=>r.url==="/memory/write")!.data.memory_id;
    get.mockResolvedValueOnce({ok:true,record:{...entry,memory_id:id,content:"完整偏好内容",summary:"偏好",tags:[],created_at:"now"}});
    await user.click(screen.getByRole("button",{name:"核对保存结果"}));
    await screen.findByText("记忆已保存");
    expect(getRequests().filter(r=>r.url==="/memory/write")).toHaveLength(1);
    expect(get).toHaveBeenLastCalledWith(id,"project-a");
  });
});
