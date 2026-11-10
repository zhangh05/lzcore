import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AuthGateView } from "../app/AuthGate";
import { membershipDraft } from "../pages/system/SystemPages";
import { BrowserRouter } from "../router";
import { installApp } from "./appFixture";

function renderOrgs() {
  window.history.replaceState({}, "", "/system/users?ws=ws-demo-1&tab=orgs");
  const backend = installApp({ role: "admin" });
  render(<BrowserRouter><AuthGateView /></BrowserRouter>);
  return backend;
}

describe("组织与成员（A14）", () => {
  it("membershipDraft：从回读成员起步，只保留组织已分配的工作区；非法角色回落 viewer", () => {
    const org = { organization_id: "o", workspace_ids: ["w1", "w2"] };
    expect(membershipDraft({ username: "a", role: "developer", workspace_ids: ["w2", "w9"] }, org)).toEqual({ username: "a", role: "developer", workspace_ids: ["w2"] });
    expect(membershipDraft({ username: "a", role: "admin" }, org).role).toBe("viewer");
    expect(membershipDraft(null, org)).toEqual({ username: "", role: "viewer", workspace_ids: [] });
  });

  it("组织列表 + 平台管理员创建组织（POST organization_id / name）", async () => {
    const { log } = renderOrgs();
    const table = await screen.findByTestId("orgs-table");
    expect(await within(table).findByText("组织 X")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("组织 id"), { target: { value: "org-new" } });
    fireEvent.change(screen.getByLabelText("组织名称"), { target: { value: "新组织" } });
    fireEvent.click(screen.getByTestId("org-create-submit"));
    await waitFor(() => expect(log.find((l) => l.method === "POST" && l.path === "/api/identity/organizations")?.body).toEqual({ organization_id: "org-new", name: "新组织" }));
    expect(await within(screen.getByTestId("orgs-table")).findByText("新组织")).toBeInTheDocument();
  });

  it("查看成员；编辑以回读的 workspace_ids 为基础写回，并回读确认", async () => {
    const { log } = renderOrgs();
    fireEvent.click(await screen.findByTestId("org-members-org-x"));
    const drawer = await screen.findByTestId("org-members");
    expect(await within(drawer).findByText("alice")).toBeInTheDocument();
    fireEvent.click(within(drawer).getByTestId("member-edit-alice"));
    const dialog = await screen.findByTestId("member-dialog");
    expect(within(dialog).getByLabelText("ws-demo-2")).toBeChecked();
    expect(within(dialog).getByLabelText("ws-legacy")).toBeChecked();
    fireEvent.change(within(dialog).getByLabelText("成员角色"), { target: { value: "developer" } });
    fireEvent.click(within(dialog).getByTestId("member-save"));
    await waitFor(() => expect(log.find((l) => l.method === "POST" && l.path.endsWith("/memberships"))?.body).toEqual({ username: "alice", role: "developer", workspace_ids: ["ws-demo-2", "ws-legacy"] }));
    expect(await screen.findByTestId("membership-readback")).toHaveTextContent("alice · 开发者 · 工作区 ws-demo-2、ws-legacy");
    expect(JSON.stringify(log)).not.toContain('"default"');
  });

  it("添加成员：选择用户与组织工作区后写入，列表出现新成员", async () => {
    const { log } = renderOrgs();
    fireEvent.click(await screen.findByTestId("org-members-org-x"));
    const drawer = await screen.findByTestId("org-members");
    await within(drawer).findByText("alice");
    fireEvent.click(within(drawer).getByTestId("member-add"));
    const dialog = await screen.findByTestId("member-dialog");
    expect(within(dialog).getByTestId("member-save")).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText("用户"), { target: { value: "bob" } });
    fireEvent.click(within(dialog).getByLabelText("ws-demo-2"));
    fireEvent.click(within(dialog).getByTestId("member-save"));
    await waitFor(() => expect(log.find((l) => l.method === "POST" && l.path.endsWith("/memberships"))?.body).toEqual({ username: "bob", role: "viewer", workspace_ids: ["ws-demo-2"] }));
    expect(await within(drawer).findByText("bob")).toBeInTheDocument();
    expect(screen.getByTestId("membership-readback")).toHaveTextContent("bob · 只读");
  });
});
