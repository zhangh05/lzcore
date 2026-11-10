import type { HTMLAttributes, ReactNode } from "react";

// 继承原生 div 属性：数据管理/运行监控的 tab 条需要在同一根元素上挂
// role="tablist" 等语义，而不是再包一层容器（会破坏 .data-center 的 flex 子项布局）。
interface FilterBarProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode;
  className?: string;
}

export function FilterBar({ children, className = "", ...rest }: FilterBarProps) {
  return <div className={`ui-filter-bar ${className}`} {...rest}>{children}</div>;
}
