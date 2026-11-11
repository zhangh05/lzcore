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
import { SystemLayout } from "./SystemLayout";

/** 路由表（阶段 2–6）。旧前端的死路径（/network、/capabilities 等）不提供静默重定向，而是说明。 */
export function RouteView() {
  const { pathname } = useLocation();
  const { hrefFor } = useShell();
  if (pathname === "/" || pathname === "") return <Navigate to={hrefFor("/workbench")} replace />;
  if (pathname === "/workbench") return <Workbench />;
  if (pathname === "/tasks") return <TasksPage />;
  if (pathname === "/library" || pathname === "/library/files" || pathname === "/library/knowledge" || pathname === "/library/memory") return <LibraryPage />;
  if (pathname === "/workflows") return <WorkflowsPage />;
  if (pathname === "/system") return <SystemLayout><SystemStatusPage /></SystemLayout>;
  if (pathname === "/system/settings") return <SystemLayout><SettingsPage /></SystemLayout>;
  if (pathname === "/system/users") return <SystemLayout><UsersPage /></SystemLayout>;
  if (pathname === "/system/workspaces") return <SystemLayout><WorkspacesAdminPage /></SystemLayout>;
  if (pathname === "/system/backups") return <SystemLayout><BackupsPage /></SystemLayout>;
  if (pathname === "/system/ecosystem") return <SystemLayout><EcosystemPage /></SystemLayout>;
  if (pathname === "/system/workers") return <SystemLayout><WorkersPage /></SystemLayout>;
  if (pathname === "/review") return <ReviewPage />;
  if (pathname === "/extensions") return <ExtensionsOverview />;
  if (pathname.startsWith("/extensions/")) return <ExtensionRoutePage pathname={pathname} />;
  return <Placeholder title="页面不存在" stage="" reason={`新前端没有「${pathname}」这个页面（旧入口不做静默重定向）。请从左侧导航进入。`} />;
}
