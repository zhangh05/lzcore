import { INBOX_SOURCE_LABEL, type InboxSource } from "../contracts/reviewInbox";
import { ACTION_LABEL } from "../contracts/outcomeState";
import { EmptyState } from "../components/EmptyState";
import { IconCheckCircle } from "../components/Icon";
import { Link } from "../router";
import { useShell } from "./shellContext";

/** 待核对列表：顶栏弹层与 /review 页共用。唯一动作「去核对」，没有一键重试。 */
export function InboxList({ compact = false, onNavigate, highlight }: { compact?: boolean; onNavigate?: () => void; highlight?: string | null }) {
  const { inbox, inboxError, refreshInbox } = useShell();
  if (inboxError) return <p className="inbox-note tone-warn" role="alert">待核对读取失败：{inboxError} <button type="button" className="btn ghost" onClick={refreshInbox}>重试读取</button></p>;
  if (!inbox) return <p className="inbox-note" role="status">读取待核对…</p>;
  const problems = (Object.entries(inbox.sources) as [InboxSource, (typeof inbox.sources)[InboxSource]][]).filter(([, s]) => s.state !== "ok");
  const entries = compact ? inbox.entries.slice(0, 6) : inbox.entries;
  return (
    <div className="inbox" data-testid="inbox-list">
      {problems.length ? (
        <ul className="inbox-sources" role="status">
          {problems.map(([src, s]) => <li key={src} className="tone-warn">{INBOX_SOURCE_LABEL[src]}：{s.state === "ok" ? "" : s.reason}</li>)}
        </ul>
      ) : null}
      {inbox.entries.length === 0 ? (
        <EmptyState testId="inbox-empty" icon={<IconCheckCircle size={24} />} title="暂无待核对项"
          reason={problems.length ? "可读来源里没有待核对项；上面列出的来源未能读取，不代表其中没有。" : "审阅项、写操作账本和任务里目前都没有需要人工核对的内容。"} />
      ) : (
        <ul className="inbox-entries">
          {entries.map((e) => (
            <li key={e.key} className={`inbox-entry ${highlight === e.key ? "is-highlighted" : ""}`} data-testid="inbox-entry" data-source={e.source}>
              <div className="inbox-entry-main">
                <span className={`status-chip tone-${e.tone}`}>{e.statusLabel}</span>
                <span className="inbox-entry-title">{e.title}</span>
                <span className="inbox-entry-src">{INBOX_SOURCE_LABEL[e.source]} · {e.id}</span>
                {!compact && e.detail ? <p className="inbox-entry-detail">{e.detail}</p> : null}
              </div>
              <Link to={e.href} className="btn" onClick={onNavigate} data-action={e.action}>{ACTION_LABEL.verify}</Link>
            </li>
          ))}
        </ul>
      )}
      {compact && inbox.entries.length > entries.length ? <p className="inbox-note">还有 {inbox.entries.length - entries.length} 项</p> : null}
    </div>
  );
}
