import { IconCloud, IconWarningCircle, IconClock } from "../components/Icon";
import { Button } from "../components/Button";

/** 鉴权前的独立状态屏：后端不可达 / 服务器错误 / 检查中。明确不是「需要登录」。 */
export function StatusScreen({ kind, title, detail, onRetry }: {
  kind: "checking" | "unreachable" | "server_error"; title: string; detail: string; onRetry?: () => void;
}) {
  const Icon = kind === "unreachable" ? IconCloud : kind === "server_error" ? IconWarningCircle : IconClock;
  return (
    <main className="status-screen" data-testid={`auth-${kind}`} role={kind === "checking" ? "status" : "alert"}>
      <div className="status-card">
        <Icon size={28} aria-hidden="true" />
        <h1>{title}</h1>
        <p>{detail}</p>
        {onRetry ? <Button variant="primary" onClick={onRetry}>重试</Button> : null}
      </div>
    </main>
  );
}
