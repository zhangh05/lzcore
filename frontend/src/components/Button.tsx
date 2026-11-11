import type { ReactNode } from "react";
import { Button as ArcButton, type ButtonProps as ArcButtonProps } from "./arc/button/button";

type Variant = "secondary" | "primary" | "ghost" | "danger";

/**
 * 产品统一按钮：Arc UI Button（按压回弹、标签切换动效、loading 态），保留原有调用方式。
 * - 默认 variant 是 secondary（Arc 默认 primary，这里显式改回，避免一屏多个主按钮）。
 * - className 里的 `sm` 映射为 Arc 的 size="sm"；其余 class 只用于布局。
 * - 默认 type="button"，避免表单内误提交。
 */
export function Button({ children, variant = "secondary", icon, className = "", type = "button", size, ...rest }:
  Omit<ArcButtonProps, "className" | "variant"> & { variant?: Variant; icon?: ReactNode; className?: string; children?: ReactNode }) {
  const classes = className.split(/\s+/).filter(Boolean);
  const small = classes.includes("sm");
  const layout = classes.filter((c) => c !== "sm").join(" ");
  return (
    <ArcButton type={type} variant={variant} size={size ?? (small ? "sm" : "md")} className={layout || undefined} {...rest}>
      {icon ? <span className="btn-icon-row">{icon}{children}</span> : children}
    </ArcButton>
  );
}
