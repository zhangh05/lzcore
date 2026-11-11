import { Component, type ErrorInfo, type ReactNode } from "react";

type Props = { children: ReactNode; scope: "page" | "app" };
type State = { error: Error | null };

/**
 * 渲染出错时显示说明，而不是整页白屏（桌面版尤其明显：窗口只剩空白）。
 * - page：包住主区；换页（resetKey 变化）后自动恢复，导航与顶栏保留。
 * - app：最外层兜底，只能重新加载。
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[lzcore] 界面渲染失败", error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="error-boundary" role="alert" data-testid={`error-boundary-${this.props.scope}`}>
        <h1 tabIndex={-1}>界面出错了</h1>
        <p>{this.props.scope === "page" ? "这个页面没能显示出来，其他页面不受影响。" : "界面没能显示出来。"}数据没有丢失。</p>
        <pre className="error-boundary-detail">{error.message || String(error)}</pre>
        <div className="error-boundary-actions">
          {this.props.scope === "page" ? <button type="button" className="btn" onClick={() => this.setState({ error: null })}>重试</button> : null}
          <button type="button" className="btn primary" onClick={() => window.location.reload()}>重新加载</button>
        </div>
      </div>
    );
  }
}
