import type { ComponentType } from "react";
import type { IconProps } from "@phosphor-icons/react";

interface TabButtonProps {
  active: boolean;
  label: string;
  /** Phosphor 图标组件。未激活 regular（单线），激活 duotone（描边 + 填充）。 */
  icon?: ComponentType<IconProps>;
  /** > 0 才渲染计数徽章，避免一排 "0" 抢视线。 */
  count?: number;
  testId?: string;
  /** 页面自己的钩子类名（数据管理用 dc-tab，运行监控用 tab）。 */
  className?: string;
  onClick: () => void;
}

/**
 * 全站统一的 tab 项。
 *
 * 此前数据管理（.dc-tab）和运行监控（.tab）是两套各写一遍的实现：
 * 高度 34 / 36、激活色 --accent-2 / --text、字重 640 / 620、计数徽章
 * 一个是 <span class="tab-count"> 一个是 opacity-60 裸 span —— 看起来像两套产品。
 *
 * 现在结构与语义（role / aria-selected / 图标 weight / 计数徽章）收敛到这里，
 * 视觉由 global.css 的「统一 tab 条」区块统一给出。页面只保留容器类名差异。
 */
export function TabButton({ active, label, icon: Icon, count, testId, className = "", onClick }: TabButtonProps) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      data-testid={testId}
      className={className ? `${className}${active ? " active" : ""}` : active ? "active" : ""}
      onClick={onClick}
    >
      {Icon ? <Icon size={15} weight={active ? "duotone" : "regular"} /> : null}
      {label}
      {count && count > 0 ? <span className="tab-count">{count}</span> : null}
    </button>
  );
}
