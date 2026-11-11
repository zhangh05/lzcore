import { useMemo } from "react";
import { Button } from "../components/Button";
import { PageHeader } from "../components/EmptyState";
import { useShell } from "../app/shellContext";
import { NAMES } from "../contracts/naming";
import { UNKNOWN_FLOW_COPY } from "../contracts/unknownFlow";
import { useSearchParams } from "../router";
import { ReviewBulk } from "./ReviewBulk";
import { ReviewDetail, targetFromParams } from "./ReviewDetail";

/**
 * 待核对收件箱（A18-审阅）。深链参数 source/id（+ artifact / session / task）直接打开核对详情面板（阶段 3）。
 */
export function ReviewPage() {
  const { refreshInbox, workspaceId } = useShell();
  const [params] = useSearchParams();
  const source = params.get("source");
  const id = params.get("id");
  const highlight = source && id ? `${source}:${id}` : null;
  const key = params.toString();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const target = useMemo(() => (workspaceId ? targetFromParams(params, workspaceId) : null), [key, workspaceId]);
  return (
    <div className="page" data-testid="review-page">
      <PageHeader title={NAMES.reviewInbox} subtitle="结果不确定的写操作、待审阅的内容和状态不明的任务。可以逐条核对，也可以勾选后批量标记。">
        <Button onClick={refreshInbox}>重新读取</Button>
      </PageHeader>
      <p className="inline-alert tone-unknown" role="note">{UNKNOWN_FLOW_COPY.rule}</p>
      {highlight ? <p className="inline-alert tone-info" role="status" data-testid="review-focus">已定位：{highlight}</p> : null}
      {target ? <ReviewDetail target={target} sessionId={params.get("session")} /> : null}
      <ReviewBulk highlight={highlight} />
    </div>
  );
}
