import { useEffect, useRef, lazy, Suspense } from "react";
import { IconClose, IconSparkle } from "./Icon";
import { SkeletonList } from "./common";
import "./FeatureDescriptionDrawer.css";

const LazyCapabilityCenter = lazy(() =>
  import("../pages/CapabilityCenter/CapabilityCenter").then((m) => ({ default: m.CapabilityCenter }))
);

interface Props {
  open: boolean;
  onClose: () => void;
}

export function FeatureDescriptionDrawer({ open, onClose }: Props) {
  const drawerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = prevOverflow;
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="feature-drawer-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="feature-drawer-title"
      data-testid="feature-description-drawer"
    >
      <div className="feature-drawer-backdrop" onClick={onClose} aria-hidden="true" />
      <div className="feature-drawer-panel" ref={drawerRef}>
        <div className="feature-drawer-header">
          <div className="feature-drawer-title-group">
            <span className="feature-drawer-icon" aria-hidden="true">
              <IconSparkle size={18} weight="duotone" />
            </span>
            <div>
              <h2 id="feature-drawer-title" className="feature-drawer-title">功能描述</h2>
              <p className="feature-drawer-subtitle">系统功能能力与底层可调用工具说明</p>
            </div>
          </div>
          <button
            type="button"
            className="feature-drawer-close-btn"
            onClick={onClose}
            aria-label="关闭功能描述"
            data-testid="btn-close-feature-drawer"
          >
            <IconClose size={18} />
          </button>
        </div>

        <div className="feature-drawer-content">
          <Suspense fallback={<SkeletonList rows={6} />}>
            <LazyCapabilityCenter
              title="功能描述"
              subtitle="先看系统能做哪几类事，再按需展开底层可调用工具"
              hidePageHeader={true}
            />
          </Suspense>
        </div>
      </div>
    </div>
  );
}
