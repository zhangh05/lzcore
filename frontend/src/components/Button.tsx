/* Adapted from frontend/src/components/ui/Button.tsx @ f1664ce (copy, edited only here). */
import type { ButtonHTMLAttributes, ReactNode } from "react";

type Variant = "secondary" | "primary" | "ghost" | "danger";

export function Button({ children, variant = "secondary", icon, className = "", type = "button", ...rest }:
  Omit<ButtonHTMLAttributes<HTMLButtonElement>, "className"> & { variant?: Variant; icon?: ReactNode; className?: string; children?: ReactNode }) {
  return (
    <button type={type} className={`btn ${variant === "secondary" ? "" : variant} ${className}`.trim()} {...rest}>
      {icon}
      {children}
    </button>
  );
}
