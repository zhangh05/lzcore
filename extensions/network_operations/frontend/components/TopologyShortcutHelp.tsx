/** TopologyShortcutHelp owns its presentation; document writes stay with the workspace controller. */
import { useCallback } from "react";
import { IconClose } from "../../../../frontend/src/components/Icon";
import { PortalModal } from "../../../../frontend/src/components/PortalModal";

export type TopologyShortcutHelpProps = {
  setShowShortcutHelp: import("react").Dispatch<
    import("react").SetStateAction<boolean>
  >;
};

export function TopologyShortcutHelp({
  setShowShortcutHelp,
}: TopologyShortcutHelpProps) {
  // Shared modal: portal to <body>, focus moves in and returns, Tab is trapped,
  // Escape and the backdrop close it — same behaviour as every other dialog.
  const close = useCallback(
    () => setShowShortcutHelp(false),
    [setShowShortcutHelp],
  );
  return (
    <PortalModal
      open
      onClose={close}
      className="shortcut-help"
      ariaLabelledBy="topology-shortcut-help-title"
    >
      <header>
        <h2 id="topology-shortcut-help-title">画布快捷键</h2>
        <button type="button" onClick={close} aria-label="关闭快捷键帮助">
          <IconClose size={14} />
        </button>
      </header>
      <dl>
        <div>
          <dt>V / C</dt>
          <dd>选择 / 连线笔模式</dd>
        </div>
        <div>
          <dt>连线模式 (C)</dt>
          <dd>极速直连两台设备，自动配对接口</dd>
        </div>
        <div>
          <dt>空白处左键拖拽</dt>
          <dd>直接拉框多选设备与链路</dd>
        </div>
        <div>
          <dt>空格 + 拖拽 / 中键拖拽</dt>
          <dd>平移画布（随时随地抓手拖动）</dd>
        </div>
        <div>
          <dt>Ctrl/⌘ + D</dt>
          <dd>克隆复制选中设备</dd>
        </div>
        <div>
          <dt>设备快捷栏</dt>
          <dd>点击设备后在画布连续点击批量放置</dd>
        </div>
        <div>
          <dt>Ctrl/⌘ + 单击</dt>
          <dd>加选设备；再点一次移出选区</dd>
        </div>
        <div>
          <dt>Shift + 单击</dt>
          <dd>加选设备</dd>
        </div>
        <div>
          <dt>拖动已选对象</dt>
          <dd>整组连续移动，靠近参考线时渐进吸附</dd>
        </div>
        <div>
          <dt>Delete / Backspace</dt>
          <dd>删除选中对象</dd>
        </div>
        <div>
          <dt>Ctrl/⌘ + A</dt>
          <dd>全选</dd>
        </div>
        <div>
          <dt>方向键</dt>
          <dd>微移选中对象 1 单位（Shift 为 8 单位）</dd>
        </div>
        <div>
          <dt>F / Shift + F</dt>
          <dd>适配全部 / 缩放至选中对象</dd>
        </div>
        <div>
          <dt>I</dt>
          <dd>切换接口标签</dd>
        </div>
        <div>
          <dt>T</dt>
          <dd>展开 / 收起编辑工具条</dd>
        </div>
        <div>
          <dt>Shift + G</dt>
          <dd>切换网格吸附</dd>
        </div>
        <div>
          <dt>Ctrl/⌘ + Z / Y</dt>
          <dd>撤销 / 恢复</dd>
        </div>
        <div>
          <dt>Ctrl/⌘ + S</dt>
          <dd>立即保存</dd>
        </div>
        <div>
          <dt>滚轮</dt>
          <dd>缩放视图</dd>
        </div>
        <div>
          <dt>Esc / 右键</dt>
          <dd>退出放置/退出连线/关闭面板</dd>
        </div>
        <div>
          <dt>?</dt>
          <dd>显示本帮助</dd>
        </div>
      </dl>
    </PortalModal>
  );
}
