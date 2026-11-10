import { ExtensionRoutePage, ExtensionsOverview } from "../pages/ExtensionPages";
import { LibraryPage } from "../pages/library/LibraryPage";
import { Placeholder } from "../pages/Placeholder";
import { ReviewPage } from "../pages/ReviewPage";
import { BackupsPage, EcosystemPage, SettingsPage, SystemStatusPage, UsersPage, WorkersPage, WorkspacesAdminPage } from "../pages/system/SystemPages";
import { TasksPage } from "../pages/tasks/TasksPage";
import { Workbench } from "../pages/workbench/Workbench";
import { WorkflowsPage } from "../pages/workflows/WorkflowsPage";
import { Navigate, useLocation } from "../router";
import { useShell } from "./shellContext";

/** 路由表（阶段 2–6）。旧前端的死路径（/network、/capabilities 等）不提供静默重定向，而是说明。 */
export function RouteView() {
  const { pathname } = useLocation();
  const { hrefFor } = useShell();
  if (pathname === "/" || pathname === "") return <Navigate to={hrefFor("/workbench")} replace />;
  if (pathname === "/workbench") return <Workbench />;
  if (pathname === "/tasks") return <TasksPage />;
  if (pathname === "/library" || pathname === "/library/files" || pathname === "/library/knowledge" || pathname === "/library/memory") return <LibraryPage />;
  if (pathname === "/workflows") return <WorkflowsPage />;
  if (pathname === "/system") return <SystemStatusPage />;
  if (pathname === "/system/settings") return <SettingsPage />;
  if (pathname === "/system/users") return <UsersPage />;
  if (pathname === "/system/workspaces") return <WorkspacesAdminPage />;
  if (pathname === "/system/backups") return <BackupsPage />;
  if (pathname === "/system/ecosystem") return <EcosystemPage />;
  if (pathname === "/system/workers") return <WorkersPage />;
  if (pathname === "/review") return <ReviewPage />;
  if (pathname === "/extensions") return <ExtensionsOverview />;
  if (pathname.startsWith("/extensions/")) return <ExtensionRoutePage pathname={pathname} />;
  return <Placeholder title="页面不存在" stage="" reason={`新前端没有「${pathname}」这个页面（旧入口不做静默重定向）。请从左侧导航进入。`} />;
}
