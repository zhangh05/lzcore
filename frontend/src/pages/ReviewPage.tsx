import { useMemo } from "react";
import { PageHeader } from "../components/EmptyState";
import { useShell } from "../app/shellContext";
import { UNKNOWN_FLOW_COPY } from "../contracts/unknownFlow";
import { Navigate, useSearchParams } from "../router";
import { ReviewDetail, targetFromParams } from "./ReviewDetail";

/**
 * 单条核对（A18-审阅）：从任务 / 工作台的「去核对」深链进入，参数 source/id（+ artifact / session / task）。
 * 没有目标时回到任务页；不再提供全局「待核对」列表。
 */
export function ReviewPage() {
  const { workspaceId, hrefFor } = useShell();
  const [params] = useSearchParams();
  const key = params.toString();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const target = useMemo(() => (workspaceId ? targetFromParams(params, workspaceId) : null), [key, workspaceId]);
  if (!workspaceId) return null;
  if (!target) return <Navigate to={hrefFor("/tasks")} replace />;
  return (
    <div className="page" data-testid="review-page">
      <PageHeader title="核对" subtitle="回读最新状态，确认后再标记结果。" />
      <p className="inline-alert tone-unknown" role="note">{UNKNOWN_FLOW_COPY.rule}</p>
      <ReviewDetail target={target} sessionId={params.get("session")} />
    </div>
  );
}
