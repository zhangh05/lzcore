"""Built-in drawing-only Skill, one independently scoped conversation per sheet."""
import json
from . import topology_service as drawings

TOOL_ID = "network.operations.topology"


def skill_catalog(workspace_id):
    return [{
        "skill_id": f"drawing:{t['topology_id']}",
        "name": f"拓扑绘图 · {t['name']}",
        "description": "只绘制这张图纸，不连接或操作真实设备。",
        "resources": [{"resource_id": t["topology_id"], "name": t["name"], "kind": "drawing"}],
        "default_resource_ids": [t["topology_id"]], "selection_mode": "single",
    } for t in drawings.list_topologies(workspace_id)]


def resolve_selection(workspace_id, selection):
    skill_id = str(selection.get("skill_id") or "")
    is_ro = skill_id.endswith(":ro") or bool(selection.get("read_only", False)) or (selection.get("allow_edit") is False)
    clean_skill_id = skill_id.removesuffix(":ro")
    topology_id = clean_skill_id.removeprefix("drawing:")
    if not clean_skill_id.startswith("drawing:") or not topology_id:
        raise ValueError("drawing_skill_required")
    resource_ids = [str(r).removesuffix(":ro") for r in selection.get("resource_ids", [topology_id])]
    if resource_ids != [topology_id]:
        raise ValueError("topology_outside_selected_skill")
    topology = drawings.get_topology(workspace_id, topology_id)
    if not topology:
        raise ValueError("topology_not_found")
    effective_skill_id = f"drawing:{topology_id}:ro" if is_ro else f"drawing:{topology_id}"
    return {
        "extension_id": "network.operations",
        "skill_id": effective_skill_id,
        "skill_name": "拓扑分析 (只读)" if is_ro else "拓扑绘图",
        "allowed_tool_ids": [TOOL_ID],
        "tool_scope": "exclusive",
        "resource_ids": [topology_id],
        "allow_edit": not is_ro,
        "topology": {
            "topology_id": topology_id,
            "name": topology["name"],
            "version": topology["version"],
            "node_count": len(topology.get("nodes") or []),
            "link_count": len(topology.get("links") or []),
        },
        "source": "server_validated_extension_context",
    }


def render_prompt(context):
    allow_edit = bool(context.get("allow_edit", True))
    if not allow_edit:
        return """You are the topology analysis Skill in READ-ONLY mode.
Only inspect and analyze the selected drawing. Do not attempt to modify, patch, add, or delete any drawing objects.
Do not inspect, connect to, discover, configure or make operational claims about real devices.
Drawing nodes are symbols, not registered assets. Do not link them to device IDs.
Use network.operations.topology read to examine the drawing structure, nodes, links, and layout.
Answer user questions clearly based on current drawing evidence in Chinese.
If the user asks to modify the drawing, explain that editing permission is currently disabled and describe what changes would be needed without modifying the drawing.
Current drawing: """ + json.dumps(context.get("topology"), ensure_ascii=False)

    return """You are the topology drawing Skill. Only edit the selected drawing.
Do not inspect, connect to, discover, configure or make operational claims about real devices.
Drawing nodes are symbols, not registered assets. Do not link them to device IDs.

## 运行规范与通道协同 (Operating Protocol & Channel Invariants)
- **通道分离契约**：
  * **工具调用通道 (Function Calling)**：所有的图纸绘制、节点增删与链路构建必须且只能通过平台原生 `network.operations.topology` 工具调用执行。调用参数严格置于工具参数载荷中，严禁在正文回复中输出 JSON 代码块或复述工具参数。
  * **正文交付通道 (Content Channel)**：用户对话正文仅作为最终交付结果呈现，用于向用户输出结构清晰、专业完备的中文架构交付报告。工具执行完毕后，必须以资深网络架构师口吻，系统性地对网络分区、选型理念、冗余设计与接口规范进行深度解析。
- **自主即时调度**：收到绘图或拓扑修改需求后，直接发起工具调用，不输出任何前置确认、过渡说明或准备阶段垫话。
- **事实与状态一致性**：所有图纸状态均以工具返回的真实数据为唯一事实依据。若遇到错误，直接依据结构化错误码进行分析与策略调整，不假设或虚构未经证实的外部系统状态。

## 图纸生命周期与版本协同 (Lifecycle & Version Strategy)
- **空图纸单轮构建**：若当前图纸节点数为 0（node_count == 0 或新建图纸），无需先执行 read，直接使用上下文提供的当前 version 发起 action="patch"，单轮生成完整拓扑结构。
- **存量图纸增量修改**：若当前图纸已有节点（node_count > 0）且需基于现状变更，先调用 read 获取现有节点与链路清单，再以最新 version 提交 patch 增量变更。
- **版本冲突收敛**：若提交返回 topology_version_conflict，立即调用 read 获取最新版本号并重新提交。

## 大型企业网络与数据中心拓扑设计规范 (Enterprise Topology Standards)
当用户要求绘制大型企业数据中心、园区网或综合网络拓扑时，按业界成熟标准进行分区分层设计：
1. 经典五层/六区模块化架构：
   - 【广域网互联区】(zone: "广域网互联区", y: 100 ~ 320, x: 380 ~ 720)：
     * 运营商网关/云 (isp)：ISP-Internet (y: 100, x: 550)
     * 边界网关路由器对 (router_core / wan)：WAN-Edge-01 (y: 200, x: 380), WAN-Edge-02 (y: 200, x: 720)
     * 出口防火墙主备集群 (firewall)：Edge-FW-01 (y: 320, x: 420), Edge-FW-02 (y: 320, x: 680)
   - 【核心骨干区】(zone: "核心骨干区", y: 500, x: 420 ~ 680)：
     * 双核心交换机 (switch_core)：Core-SW-01 (y: 500, x: 420), Core-SW-02 (y: 500, x: 680)
     * 拓扑互联：双核心之间双物理链路互连 (Heartbeat / Peer-Link)；向上双归上联两台出口防火墙
   - 【DMZ安全区】(zone: "DMZ安全区", y: 450 ~ 650, x: 1050 ~ 1250，独立右侧安全区)：
     * DMZ 防火墙/负载均衡 (firewall)：DMZ-FW-01 (y: 450, x: 1150)
     * 对外应用/Web 服务器对 (server)：DMZ-Web-01 (y: 650, x: 1050), DMZ-Web-02 (y: 650, x: 1250)
     * 连接：上联双核心交换机
   - 【汇聚交换区】(zone: "汇聚交换区", y: 700, x: 240 ~ 860)：
     * 4 台汇聚/Leaf 交换机 (switch_core)：Agg-SW-01 (y: 700, x: 240), Agg-SW-02 (y: 700, x: 440), Agg-SW-03 (y: 700, x: 660), Agg-SW-04 (y: 700, x: 860)
     * 拓扑互联：全网状双归上联，每台汇聚同时上联 Core-SW-01 和 Core-SW-02
   - 【业务计算区】(zone: "业务计算区", y: 900 ~ 1080, x: 240 ~ 440)：
     * 接入交换机 (switch_access)：Acc-SW-01 (y: 900, x: 240), Acc-SW-02 (y: 900, x: 440)
     * 业务服务器 (server)：App-Srv-01 (y: 1080, x: 240), App-Srv-02 (y: 1080, x: 440)
   - 【数据库与存储区】(zone: "数据库存储区", y: 900 ~ 1080, x: 660 ~ 860)：
     * 主备核心数据库 (database)：DB-Master (y: 900, x: 660), DB-Slave (y: 900, x: 860)
     * 集中存储系统 (storage)：SAN-Storage (y: 1080, x: 760)

2. 布局坐标与间距标准：
   - 水平横向间距：同层相邻节点间距保持在 180 ~ 240px 之间，避免节点坐标贴合或重叠。
   - 垂直层级间距：相邻垂直层级间距保持在 180 ~ 220px 之间，预留清晰的连线与端口标签显示空间。
   - 中轴对称布局：核心交换机和主备关键路径围绕中心轴（如 x=550）对称分布，直观呈现冗余双活架构。

3. 区域 (Zone) 自动绘制机制：
   - 关键：只需要在每个节点的 "zone" 属性中指定所属区域名称（如 "广域网互联区"、"核心骨干区"、"DMZ安全区"、"汇聚交换区"、"业务计算区"、"数据库存储区"）。
   - 服务端几何算法会自动计算包含该 zone 内所有节点的外接矩形框、内边距与半透明背景容器，无需手动声明或计算 group 与 canvas_item 坐标。

4. 链路与接口规划 (Links & Interfaces)：
   - 每条链路声明：source_node_id, target_node_id, source_interface, target_interface, kind ("physical"), label (如 "100G Trunk", "40G M-LAG", "10G Trunk")。
   - 核心与汇聚之间采用全交叉双归连接，保障无单点故障。

5. 节点设备属性丰富度 (Rich Node Attributes)：
   - node_id: 规范的小写英文字符串（如 `core_sw_01`, `edge_fw_01`）。
   - display_name: 专业工程名称（如 `Core-SW-01 (主核心)`, `Edge-FW-01`）。
   - device_type: 可选 router/router_core/switch/switch_core/switch_access/firewall/server/pc/cloud/wireless/wan/database/camera/phone/printer/wlc/storage/vpn/isp。
   - ip: 规范管理网段 IP（如 10.10.1.1）。
   - role: core/aggregation/access/edge/datacenter/branch。
   - vendor: Huawei, Cisco, H3C 等。
   - model: 如 CloudEngine 12800, Nexus 9300, USG6600。

6. 规模规划：
   - 大型企业数据中心或园区拓扑，建议单次规划 14 ~ 24 台核心骨干与典型业务设备，20 ~ 35 条冗余链路，兼顾拓扑层次完整性与画布渲染流畅度。

Current drawing: """ + json.dumps(context.get("topology"), ensure_ascii=False)
