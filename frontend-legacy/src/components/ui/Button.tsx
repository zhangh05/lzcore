import type { ButtonHTMLAttributes, ReactNode } from "react";

type ButtonVariant = "default" | "primary" | "selected" | "ghost" | "danger" | "danger-ghost" | "danger-confirm";
type ButtonSize = "default" | "sm" | "lg";

interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "className"> {
  children?: ReactNode;
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: ReactNode;
  iconOnly?: boolean;
  className?: string;
  /** Shows a spinner, sets aria-busy and blocks repeat clicks while pending. */
  loading?: boolean;
}

export function Button({
  children,
  variant = "default",
  size = "default",
  icon,
  iconOnly,
  className = "",
  loading = false,
  disabled,
  ...rest
}: ButtonProps) {
  const variantClass = variant === "default" ? "" : variant;
  const sizeClass = size === "default" ? "" : size;
  const iconOnlyClass = iconOnly ? "icon-only" : "";
  if (import.meta.env.DEV && iconOnly && !rest["aria-label"] && !rest["aria-labelledby"]) {
    console.warn("Icon-only buttons require aria-label or aria-labelledby.");
  }

  return (
    <button
      className={`btn ${variantClass} ${sizeClass} ${iconOnlyClass} ${loading ? "is-loading" : ""} ${className}`.replace(/\s+/g, " ").trim()}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      type={rest.type ?? "button"}
      {...rest}
    >
      {icon}
      {children}
    </button>
  );
}
