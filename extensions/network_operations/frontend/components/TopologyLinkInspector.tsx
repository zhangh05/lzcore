/** TopologyLinkInspector owns its presentation; document writes stay with the workspace controller. */
import {
  IconBranch,
  IconClose,
  IconTrash,
} from "../../../../frontend/src/components/Icon";
import { Button } from "../../../../frontend/src/components/ui";
import { LinkColorControl } from "./LinkColorControl";
import type {
  SelectedElement,
  Topology,
  TopologyLink,
} from "./topologyDocument";

export type TopologyLinkInspectorProps = {
  activeTopology: Topology;
  handleHeaderMouseDown: (e: React.MouseEvent) => void;
  handleRemoveLink: (linkId: string) => Promise<void>;
  nodeLabelById: Map<string, string>;
  pinButton: import("react").JSX.Element;
  pushState: (next: Topology) => void;
  selectedLink: TopologyLink;
  setIsInspectorOpen: import("react").Dispatch<
    import("react").SetStateAction<boolean>
  >;
  setSelectedElement: import("react").Dispatch<
    import("react").SetStateAction<SelectedElement>
  >;
};

export function TopologyLinkInspector({
  activeTopology,
  handleHeaderMouseDown,
  handleRemoveLink,
  nodeLabelById,
  pinButton,
  pushState,
  selectedLink,
  setIsInspectorOpen,
  setSelectedElement,
}: TopologyLinkInspectorProps) {
  return (
    <div className="inspector-panel">
      <div className="inspector-header" onMouseDown={handleHeaderMouseDown}>
        <div className="inspector-header-left">
          <span className="inspector-drag-grip" title="按住拖拽移动弹窗">
            ⋮⋮
          </span>
          <div className="inspector-icon-wrap">
            <IconBranch size={16} style={{ color: "var(--accent)" }} />
          </div>
          <div className="inspector-header-titles">
            <h4>链路属性</h4>
            <span className="inspector-badge">
              {nodeLabelById.get(selectedLink.source_node_id) ||
                selectedLink.source_node_id}{" "}
              ↔{" "}
              {nodeLabelById.get(selectedLink.target_node_id) ||
                selectedLink.target_node_id}
            </span>
          </div>
        </div>
        <div className="inspector-header-actions">
          {pinButton}
          <Button
            size="sm"
            onClick={() => {
              setSelectedElement(null);
              setIsInspectorOpen(false);
            }}
            aria-label="收起链路详情"
          >
            <IconClose size={13} />
          </Button>
        </div>
      </div>

      <div className="inspector-body">
        <div className="inspector-section">
          <div className="inspector-endpoints-card">
            <div className="endpoint-col">
              <small>源端</small>
              <strong>
                {nodeLabelById.get(selectedLink.source_node_id) ||
                  selectedLink.source_node_id}
              </strong>
              <input
                value={selectedLink.source_interface}
                aria-label="源端接口"
                placeholder="源接口"
                onChange={(e) => {
                  if (!activeTopology) return;
                  const val = e.target.value;
                  const updated = activeTopology.links.map((l) =>
                    l.link_id === selectedLink.link_id
                      ? { ...l, source_interface: val }
                      : l,
                  );
                  pushState({ ...activeTopology, links: updated });
                }}
              />
            </div>
            <div className="endpoint-divider">↔</div>
            <div className="endpoint-col">
              <small>对端</small>
              <strong>
                {nodeLabelById.get(selectedLink.target_node_id) ||
                  selectedLink.target_node_id}
              </strong>
              <input
                value={selectedLink.target_interface}
                aria-label="对端接口"
                placeholder="对端接口"
                onChange={(e) => {
                  if (!activeTopology) return;
                  const val = e.target.value;
                  const updated = activeTopology.links.map((l) =>
                    l.link_id === selectedLink.link_id
                      ? { ...l, target_interface: val }
                      : l,
                  );
                  pushState({ ...activeTopology, links: updated });
                }}
              />
            </div>
          </div>
        </div>

        <div className="inspector-section">
          <label className="inspector-field">
            链路状态
            <select
              value={selectedLink.status}
              onChange={(e) => {
                if (!activeTopology) return;
                const val = e.target.value as "unknown" | "up" | "down";
                const updated = activeTopology.links.map((l) =>
                  l.link_id === selectedLink.link_id
                    ? { ...l, status: val }
                    : l,
                );
                pushState({ ...activeTopology, links: updated });
              }}
            >
              <option value="unknown">未知 (缺少证据)</option>
              <option value="up">图纸标注：UP（非运行结论）</option>
              <option value="down">图纸标注：DOWN（非运行结论）</option>
            </select>
          </label>

          <div className="inspector-label" style={{ marginTop: "4px" }}>
            连线外观与形态
          </div>

          <div className="inspector-field">
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
              }}
            >
              <span>走线形态</span>
              {selectedLink.style?.curve_style === "bezier" && (
                <button
                  type="button"
                  className="curve-reverse-btn"
                  onClick={() => {
                    if (!activeTopology) return;
                    const isRev = !selectedLink.style?.curve_reverse;
                    const updated = activeTopology.links.map((l) =>
                      l.link_id === selectedLink.link_id
                        ? { ...l, style: { ...l.style, curve_reverse: isRev } }
                        : l,
                    );
                    pushState({ ...activeTopology, links: updated });
                  }}
                  title="翻转圆弧弯曲朝向"
                >
                  {selectedLink.style?.curve_reverse
                    ? "⤹ 弧向(下)"
                    : "⤥ 弧向(上)"}
                </button>
              )}
            </div>
            <div className="curve-style-chips">
              {[
                {
                  id: "auto",
                  name: "自动避让",
                  tip: "默认：智能避让·并行链路自动分流",
                  icon: (
                    <svg
                      width="14"
                      height="14"
                      viewBox="0 0 16 16"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.8"
                      strokeLinecap="round"
                    >
                      <path d="M2 11C6 11 10 5 14 5" />
                      <path d="M2 14C7 14 9 8 14 8" strokeDasharray="2 2" />
                    </svg>
                  ),
                },
                {
                  id: "taxi",
                  name: "正交折线",
                  tip: "正交折线·机柜机房规范布线",
                  icon: (
                    <svg
                      width="14"
                      height="14"
                      viewBox="0 0 16 16"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.8"
                      strokeLinecap="round"
                    >
                      <path d="M2 13H8V4H14" />
                    </svg>
                  ),
                },
                {
                  id: "bezier",
                  name: "圆弧曲线",
                  tip: "平滑弧线·跨区域美观弧线",
                  icon: (
                    <svg
                      width="14"
                      height="14"
                      viewBox="0 0 16 16"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.8"
                      strokeLinecap="round"
                    >
                      <path d="M2 13C6 4 10 4 14 13" />
                    </svg>
                  ),
                },
                {
                  id: "straight",
                  name: "直线直达",
                  tip: "最短直达·两点直接相连",
                  icon: (
                    <svg
                      width="14"
                      height="14"
                      viewBox="0 0 16 16"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.8"
                      strokeLinecap="round"
                    >
                      <line x1="2" y1="13" x2="14" y2="3" />
                    </svg>
                  ),
                },
              ].map((option) => {
                const currentStyle = selectedLink.style?.curve_style || "auto";
                const isActive = currentStyle === option.id;
                return (
                  <button
                    key={option.id}
                    type="button"
                    className={`curve-chip ${isActive ? "is-active" : ""}`}
                    onClick={() => {
                      if (!activeTopology) return;
                      const val = option.id as
                        | "auto"
                        | "bezier"
                        | "straight"
                        | "taxi";
                      const updated = activeTopology.links.map((l) =>
                        l.link_id === selectedLink.link_id
                          ? {
                              ...l,
                              style: {
                                ...l.style,
                                curve_style: val === "auto" ? undefined : val,
                              },
                            }
                          : l,
                      );
                      pushState({ ...activeTopology, links: updated });
                    }}
                    title={option.tip}
                  >
                    {option.icon}
                    <span>{option.name}</span>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="inspector-field">
            <span>线型风格</span>
            <div className="line-style-chips">
              {[
                {
                  id: "solid",
                  name: "实线",
                  icon: (
                    <svg width="28" height="6" viewBox="0 0 28 6" fill="none">
                      <line
                        x1="0"
                        y1="3"
                        x2="28"
                        y2="3"
                        stroke="currentColor"
                        strokeWidth="2.5"
                        strokeLinecap="round"
                      />
                    </svg>
                  ),
                },
                {
                  id: "dashed",
                  name: "虚线",
                  icon: (
                    <svg width="28" height="6" viewBox="0 0 28 6" fill="none">
                      <line
                        x1="0"
                        y1="3"
                        x2="28"
                        y2="3"
                        stroke="currentColor"
                        strokeWidth="2.5"
                        strokeDasharray="5 3"
                      />
                    </svg>
                  ),
                },
                {
                  id: "dotted",
                  name: "点线",
                  icon: (
                    <svg width="28" height="6" viewBox="0 0 28 6" fill="none">
                      <line
                        x1="1"
                        y1="3"
                        x2="27"
                        y2="3"
                        stroke="currentColor"
                        strokeWidth="2.5"
                        strokeLinecap="round"
                        strokeDasharray="0.1 4"
                      />
                    </svg>
                  ),
                },
              ].map((preset) => {
                const currentLineStyle =
                  selectedLink.style?.line_style ||
                  (selectedLink.kind === "logical" ? "dashed" : "solid");
                const isActive = currentLineStyle === preset.id;
                return (
                  <button
                    key={preset.id}
                    type="button"
                    className={`line-chip ${isActive ? "is-active" : ""}`}
                    onClick={() => {
                      if (!activeTopology) return;
                      const val = preset.id as "solid" | "dashed" | "dotted";
                      const updated = activeTopology.links.map((l) =>
                        l.link_id === selectedLink.link_id
                          ? {
                              ...l,
                              kind: (val === "dashed"
                                ? "logical"
                                : "physical") as "physical" | "logical",
                              style: { ...l.style, line_style: val },
                            }
                          : l,
                      );
                      pushState({ ...activeTopology, links: updated });
                    }}
                    title={`${preset.name}样式`}
                  >
                    {preset.icon}
                    <span>{preset.name}</span>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="inspector-field">
            <span>
              线宽粗细 (
              {selectedLink.style?.width
                ? `${selectedLink.style.width}px`
                : "标准 2.5px"}
              )
            </span>
            <div className="link-width-chips">
              {[
                { label: "细 1.5", value: 1.5 },
                { label: "标准 2.5", value: 2.5 },
                { label: "粗 4", value: 4 },
                { label: "特粗 6", value: 6 },
              ].map((preset) => {
                const currentWidth = selectedLink.style?.width ?? 2.5;
                const isActive = currentWidth === preset.value;
                return (
                  <button
                    key={preset.value}
                    type="button"
                    className={`link-width-chip ${isActive ? "active" : ""}`}
                    onClick={() => {
                      if (!activeTopology) return;
                      const updated = activeTopology.links.map((l) =>
                        l.link_id === selectedLink.link_id
                          ? { ...l, style: { ...l.style, width: preset.value } }
                          : l,
                      );
                      pushState({ ...activeTopology, links: updated });
                    }}
                  >
                    {preset.label}
                  </button>
                );
              })}
            </div>
          </div>

          <LinkColorControl
            link={selectedLink}
            onChange={(color) => {
              if (!activeTopology) return;
              const links = activeTopology.links.map((link) => {
                if (link.link_id !== selectedLink.link_id) return link;
                const style = { ...link.style };
                if (color) style.color = color;
                else delete style.color;
                return {
                  ...link,
                  style: Object.keys(style).length ? style : undefined,
                };
              });
              pushState({ ...activeTopology, links });
            }}
          />

          {(selectedLink.style?.color ||
            selectedLink.style?.width ||
            selectedLink.style?.line_style ||
            selectedLink.style?.curve_style) && (
            <button
              type="button"
              className="link-full-reset-btn"
              onClick={() => {
                if (!activeTopology) return;
                const updated = activeTopology.links.map((l) =>
                  l.link_id === selectedLink.link_id
                    ? { ...l, style: undefined }
                    : l,
                );
                pushState({ ...activeTopology, links: updated });
              }}
            >
              ↺ 恢复系统默认样式与走线
            </button>
          )}

          <label className="inspector-field">
            链路描述（可选）
            <input
              value={selectedLink.label || ""}
              placeholder="如：CE1 接入线路、主干 Trunk"
              onChange={(e) => {
                if (!activeTopology) return;
                const val = e.target.value;
                const updated = activeTopology.links.map((l) =>
                  l.link_id === selectedLink.link_id
                    ? { ...l, label: val || undefined }
                    : l,
                );
                pushState({ ...activeTopology, links: updated });
              }}
            />
          </label>

          <label className="inspector-check">
            <input
              type="checkbox"
              checked={Boolean(selectedLink.metadata?.show_description)}
              onChange={(e) => {
                if (!activeTopology) return;
                const show_description = e.target.checked;
                const updated = activeTopology.links.map((l) =>
                  l.link_id === selectedLink.link_id
                    ? {
                        ...l,
                        metadata: {
                          ...l.metadata,
                          show_description: show_description || undefined,
                        },
                      }
                    : l,
                );
                pushState({ ...activeTopology, links: updated });
              }}
            />
            <span>在画布显示此描述</span>
          </label>

          <label className="inspector-field">
            速率 (Speed)
            <input
              value={(selectedLink.metadata?.speed as string) || ""}
              placeholder="如：10Gbps"
              onChange={(e) => {
                if (!activeTopology) return;
                const val = e.target.value;
                const updated = activeTopology.links.map((l) =>
                  l.link_id === selectedLink.link_id
                    ? {
                        ...l,
                        metadata: { ...l.metadata, speed: val || undefined },
                      }
                    : l,
                );
                pushState({ ...activeTopology, links: updated });
              }}
            />
          </label>

          <label className="inspector-field">
            VLAN / 业务网段
            <input
              value={(selectedLink.metadata?.vlan as string) || ""}
              placeholder="如：VLAN 100 / 192.168.1.0/30"
              onChange={(e) => {
                if (!activeTopology) return;
                const val = e.target.value;
                const updated = activeTopology.links.map((l) =>
                  l.link_id === selectedLink.link_id
                    ? {
                        ...l,
                        metadata: { ...l.metadata, vlan: val || undefined },
                      }
                    : l,
                );
                pushState({ ...activeTopology, links: updated });
              }}
            />
          </label>
        </div>

        <div className="inspector-actions">
          <Button
            variant="danger"
            icon={<IconTrash size={13} />}
            onClick={() => handleRemoveLink(selectedLink.link_id)}
          >
            删除此链路
          </Button>
        </div>
      </div>
    </div>
  );
}
