import { memo } from "react";
import type { StageOutput } from "../../../types";
import { renderAssistantHtml } from "../../../utils/displayText";

export const StageOutputs = memo(function StageOutputs({ stages }: { stages: StageOutput[] }) {
  if (!stages.length) return null;
  return (
    <section className="stage-outputs" aria-label="阶段输出">
      {stages.map((stage, index) => (
        <details className="stage-output" key={`${stage.id}-${index}`}>
          <summary>{stage.label}<span className="muted">已保留 · 展开查看</span></summary>
          <div className="markdown-body stage-output-body" dangerouslySetInnerHTML={{ __html: renderAssistantHtml(stage.text) }} />
        </details>
      ))}
    </section>
  );
});
