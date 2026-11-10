import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { vi } from "vitest";
import { authApi, identityApi } from "../api";
import { UserManagement } from "../pages/UserManagement/UserManagement";
import { ConfirmHost } from "../components/ConfirmDialog";

test("shows the dedicated access manager to the platform administrator", async () => {
  vi.spyOn(authApi, "status").mockResolvedValue({ ok: true, login_enabled: true, authenticated: true, username: "Admin", role: "admin", organization_id: "default", workspace_ids: ["default"], identity_enabled: true, platform_admin: true });
  vi.spyOn(identityApi, "organizations").mockResolvedValue({ ok: true, organizations: [{ organization_id: "default", name: "默认组织", workspace_ids: ["default"] }] });
  vi.spyOn(identityApi, "users").mockResolvedValue({ ok: true, users: [{ username: "alice", role: "viewer", organization_id: "default", workspace_ids: ["default"], enabled: true }] });
  vi.spyOn(identityApi, "deleteUser").mockResolvedValue({ ok: true, deleted: true, user: { username: "alice", role: "viewer", organization_id: "default", workspace_ids: ["default"], enabled: true } });
  const native = vi.fn(() => true);
  vi.stubGlobal("confirm", native);
  render(<><UserManagement /><ConfirmHost /></>);
  await waitFor(() => expect(screen.getByText("平台管理员 · 权限不可被普通用户修改")).toBeInTheDocument());
  fireEvent.click(screen.getByText("alice"));
  expect(screen.getByText("编辑用户权限")).toBeInTheDocument();
  expect(screen.getAllByText("只读用户").length).toBeGreaterThan(0);
  expect(screen.queryByText("工作区范围")).not.toBeInTheDocument();
  expect(screen.queryByText("可分配工作区")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "删除用户" }));
  await screen.findByRole("dialog", { name: "删除普通用户「alice」？" });
  fireEvent.click(screen.getAllByRole("button", { name: "删除用户" }).at(-1)!);
  await waitFor(() => expect(identityApi.deleteUser).toHaveBeenCalledWith("alice"));
  expect(native).not.toHaveBeenCalled();
});

test("cancelling the delete dialog keeps the user", async () => {
  vi.spyOn(authApi, "status").mockResolvedValue({ ok: true, login_enabled: true, authenticated: true, username: "Admin", role: "admin", organization_id: "default", workspace_ids: ["default"], identity_enabled: true, platform_admin: true });
  vi.spyOn(identityApi, "organizations").mockResolvedValue({ ok: true, organizations: [{ organization_id: "default", name: "默认组织", workspace_ids: ["default"] }] });
  vi.spyOn(identityApi, "users").mockResolvedValue({ ok: true, users: [{ username: "alice", role: "viewer", organization_id: "default", workspace_ids: ["default"], enabled: true }] });
  const remove = vi.spyOn(identityApi, "deleteUser").mockClear();
  render(<><UserManagement /><ConfirmHost /></>);
  fireEvent.click(await screen.findByText("alice"));
  fireEvent.click(screen.getByRole("button", { name: "删除用户" }));
  await screen.findByRole("dialog", { name: "删除普通用户「alice」？" });
  fireEvent.click(screen.getByRole("button", { name: "取消" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  expect(remove).not.toHaveBeenCalled();
  expect(screen.getByText("编辑用户权限")).toBeInTheDocument();
});

test("refuses to render management controls for an ordinary user", async () => {
  vi.spyOn(authApi, "status").mockResolvedValue({ ok: true, login_enabled: true, authenticated: true, username: "alice", role: "viewer", organization_id: "default", workspace_ids: ["default"], identity_enabled: true, platform_admin: false });
  render(<UserManagement />);
  await waitFor(() => expect(screen.getByText("无权访问用户管理")).toBeInTheDocument());
  expect(screen.queryByRole("button", { name: "新建用户" })).not.toBeInTheDocument();
});
