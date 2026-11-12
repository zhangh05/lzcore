import { Suspense, useState } from "react";
import { api, describeFailure, enc } from "../api/client";
import { Button } from "../components/Button";
import { EmptyState, PageHeader } from "../components/EmptyState";
import { moduleFor } from "../extension-modules/registry";
import { IconArrowUpRight, IconPuzzle, IconWarningCircle } from "../components/Icon";
import { NavIcon } from "../components/NavIcon";
import { canReenable, extensionAvailability, resolveExtensionRoute, type ExtensionCatalogItem } from "../contracts/extensions";
import { extensionRouteTitle, NAMES } from "../contracts/naming";
import { Link } from "../router";
import { useShell } from "../app/shellContext";

/** `/extensions/**`：任何情况下都给出原因，不出现 404。 */
export function ExtensionRoutePage({ pathname }: { pathname: string }) {
  const { extensions, hrefFor, workspaceId } = useShell();
  const r = resolveExtensionRoute(pathname, extensions);
  const back = <Link to={hrefFor("/extensions")} className="btn primary">查看{NAMES.extensions}</Link>;
  switch (r.kind) {
    case "loading":
      return <div className="page"><PageHeader title={NAMES.extensions} /><p role="status">读取扩展目录…</p></div>;
    case "registry_error":
      return <div className="page" data-testid="ext-registry-error"><PageHeader title={NAMES.extensions} />
        <EmptyState icon={<IconWarningCircle size={24} />} title="扩展目录不可读" reason={r.reason} action={back} /></div>;
    case "not_installed":
      return <div className="page" data-testid="ext-not-installed"><PageHeader title={NAMES.extensions} />
        <EmptyState icon={<IconPuzzle size={24} />} title="扩展未安装" reason={r.reason} action={back} /></div>;
    case "unavailable":
      return <div className="page" data-testid="ext-unavailable"><PageHeader title={extensionRouteTitle(r.mount.extensionName, r.mount.label)} />
        <EmptyState icon={<IconWarningCircle size={24} />} title="扩展暂不可用" reason={r.reason} action={back} />
        {(() => { const ext = extensions.kind === "ready" ? extensions.extensions.find((e) => e.extension_id === r.mount.extensionId) : undefined; return ext && canReenable(ext) ? <ReenableExtension ext={ext} /> : null; })()}</div>;
    case "mounted": {
      const Module = moduleFor(r.mount.extensionId, r.mount.path);
      return <div className="page page-ext" data-testid="ext-mounted"><PageHeader title={extensionRouteTitle(r.mount.extensionName, r.mount.label)} subtitle={r.mount.description} />
        {Module && workspaceId ? (
          <Suspense fallback={<p role="status">加载扩展界面…</p>}>
            <Module ws={workspaceId} mountPath={r.mount.path} subPath={pathname.slice(r.mount.path.length)} />
          </Suspense>
        ) : (
          <EmptyState icon={<IconPuzzle size={24} />} title="扩展可用，但新前端没有它的界面模块"
            reason="该扩展已注册且可用，但新前端的扩展模块注册表里没有对应的界面实现。" action={back} testId="ext-no-module" />
        )}</div>;
    }
    default:
      return null;
  }
}

export function ExtensionsOverview() {
  const { extensions, auth, hrefFor } = useShell();
  return (
    <div className="page" data-testid="extensions-overview">
      <PageHeader title={NAMES.extensions} subtitle="已安装的扩展，以及它们提供的页面。" />
      {extensions.kind === "loading" ? <p role="status">读取扩展目录…</p> : null}
      {extensions.kind === "error" ? <EmptyState icon={<IconWarningCircle size={24} />} title="扩展目录不可读" reason={extensions.reason} /> : null}
      {extensions.kind === "ready" && extensions.extensions.length === 0
        ? <EmptyState icon={<IconPuzzle size={24} />} title="暂无已安装扩展" reason="安装扩展后，它提供的页面会出现在左侧导航的扩展区。" /> : null}
      {extensions.kind === "ready" && extensions.extensions.length > 0 ? (
        <ul className="ext-grid">
          {extensions.extensions.map((ext) => {
            const a = extensionAvailability(ext, auth.role || undefined);
            const pages = extensions.mounts.filter((m) => m.extensionId === ext.extension_id);
            return (
              <li key={ext.extension_id} className="ext-card" data-testid="ext-row">
                <div className="ext-card-head">
                  <span className="ext-card-icon" aria-hidden="true"><NavIcon name={pages[0]?.icon ?? "puzzle"} size={18} /></span>
                  <div className="ext-card-title">
                    <strong>{ext.name}</strong>
                    <span className="muted">{ext.version ? `v${ext.version}` : "未标版本"}</span>
                  </div>
                  {a.available ? <span className="status-chip tone-ok">可用</span> : <span className="status-chip tone-warn" title={a.reason}>不可用</span>}
                </div>
                {ext.description ? <p className="ext-card-desc">{ext.description}</p> : null}
                {!a.available ? <p className="ext-card-reason">{a.reason}</p> : null}
                {canReenable(ext) ? <ReenableExtension ext={ext} /> : null}
                <div className="ext-card-links">
                  {pages.length ? pages.map((m) => (
                    <Link key={m.path} to={hrefFor(m.path)} className="btn sm">{m.label}<IconArrowUpRight size={14} aria-hidden="true" /></Link>
                  )) : <span className="muted">无界面（仅后端能力）</span>}
                </div>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}

/** 重新启用已停用 / 被自动隔离的扩展。路由在启动时注册，所以服务端要求重启后才生效，这里如实说明。 */
function ReenableExtension({ ext }: { ext: ExtensionCatalogItem }) {
  const [state, setState] = useState<{ kind: "idle" | "busy" } | { kind: "done"; restart: boolean } | { kind: "failed"; reason: string }>({ kind: "idle" });
  return (
    <div className="row-actions" data-testid="ext-reenable">
      <Button className="sm" disabled={state.kind === "busy" || state.kind === "done"} onClick={async () => {
        setState({ kind: "busy" });
        const o = await api.post(`/api/extensions/${enc(ext.extension_id)}/enable`, {});
        if (o.kind === "http" && o.status < 300) setState({ kind: "done", restart: (o.body as { restart_required?: boolean } | null)?.restart_required !== false });
        else setState({ kind: "failed", reason: describeFailure(o) });
      }}>{state.kind === "busy" ? "启用中…" : "重新启用"}</Button>
      {state.kind === "done" ? <span role="status">已重新启用。{state.restart ? "请重启应用（或后端服务）后生效。" : ""}</span> : null}
      {state.kind === "failed" ? <span role="alert" className="inline-alert tone-warn">没有启用：{state.reason}</span> : null}
    </div>
  );
}
