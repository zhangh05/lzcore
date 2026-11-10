import { EmptyState, PageHeader } from "../components/EmptyState";
import { IconClock } from "../components/Icon";
import { Link } from "../router";
import { useShell } from "../app/shellContext";
import { NAMES } from "../contracts/naming";

/** 统一页头 + 空态。明确写出「本阶段未实现」，不假装已切流。 */
export function Placeholder({ title, stage, reason }: { title: string; stage: string; reason: string }) {
  const { hrefFor } = useShell();
  return (
    <div className="page" data-testid="placeholder-page">
      <PageHeader title={title} subtitle={stage ? `新前端${stage}交付，当前未切流` : undefined} />
      <EmptyState icon={<IconClock size={24} />} title={stage ? "本阶段尚未实现" : "找不到页面"} reason={reason}
        action={<Link to={hrefFor("/workbench")} className="btn primary">返回{NAMES.workbench}</Link>} />
    </div>
  );
}
