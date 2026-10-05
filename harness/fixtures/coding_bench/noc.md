实现 NEXUS NOC：真正运行的网络运维中心，从零创建完整工程在 {{PROJECT_DIR}}，不读取、复制或修改 LZCore 仓库、凭据或服务配置。优先 TypeScript/React/Vite、Node、持久化数据库、SSE；允许选择等价方案，但不允许静态 Dashboard、固定指标或假 PASS。

工程必须有 npm test 和 npm run build，后台启动预览 {{PREVIEW_ORIGIN}}，PID 写 /tmp/lzcore-bench-server.pid；常驻进程标准输入输出重定向，不能阻塞工具。逐阶段保持能运行，测试出错自行修复；使用 browser.manage 真实操作页面、检查控制台。遇到运行时策略限制如实报告，禁止自行扩大权限。

功能和规则：
- Overview、Topology、Devices、Interfaces、Alerts、Events、Syslog、Performance、Routing、Configuration、Inventory、Automation、Audit、Settings 14 个可用页面。深色专业紧凑 UI，1280×720 能操作；表格排序、筛选、搜索。
- 初始至少 50 台设备、300 个接口、80 条链路和 4 个站点（总部、分支、数据中心、灾备）。角色包含核心、路由、汇聚、接入、WAN、防火墙、无线和服务器。设备具备稳定 ID、名称、IP、厂商、型号、角色、序列号、版本、站点、状态、uptime、CPU、内存、温度、lastSeen、tags。
- 接口包含 admin/oper、speed/duplex/MTU/MAC/IP、RX/TX bytes/packets/bps/pps、errors、CRC、discards、noBuffers、利用率和 lastChange。1 秒或 5 秒持续模拟，计数器单调累加，速率由计数器差值计算，正确处理重启与重置；不是前端随机生成。
- 指标包含业务昼夜、会议、备份、广播风暴的相关行为；带宽高、PPS 高、CRC、noBuffers、丢包必须是不同故障。曲线具备 15 分钟/1h/6h/24h/7d 范围；设备和接口详情可用。
- 可缩放、平移、选中和手动/自动排列的拓扑，层级 Global/Site/Group/Device。链路状态来自实际两端接口。
- 告警规则支持 CPU>85%5min、内存>90%5min、接口 Down、error rate>2%、CRC/noBuffers 增量、丢包>5%、OSPF/BGP Down、设备失联。OK/Pending/Firing/Acknowledged/Resolved 状态，去重、恢复、持续时间、最后更新、严重级别、筛选、确认和详情。事件与告警分离。
- Syslog 支持级别/设备/时间/关键词筛选，实时持续接收，至少 10000 条并保持前端有界；事件包含接口状态、路由、配置、重启、登录、确认告警。
- OSPF routerID/area/neighbour/state/deadTimer/interface 和 BGP peer/AS/state/prefixes/uptime。WAN 中断→OSPF Down→站点失联，核心 Down→下游失联；根因依据依赖图、拓扑、事件时序，不是固定文案。
- 故障实验室：DeviceDown、InterfaceDown、HighCPU、HighMemory、TrafficBurst、HighPPS、noBuffers、CRC、PacketLoss、OSPFDown、BGPDown、Flapping、BroadcastStorm。可手动恢复或按时自动恢复，指标/告警/拓扑正确恢复。
- 配置当前与历史版本、备份、真实行级 Diff（新增/删除/变化）、修改人/时间/原因、回滚预览与回滚。手动和定时备份。所有重要动作有审计记录。
- 健康值依据可用率、CPU、内存、接口和严重告警计算。全局搜索名称/IP/接口/站点/告警/Syslog。
- admin/operator/viewer 角色，服务端验证写权限。刷新及进程重启保留设备、拓扑、告警状态、配置、审计和设置。断线重连有状态提示、批处理/限流/过期丢弃。
- 真实后端提供 devices/interfaces/metrics/alerts/events/syslog/config/topology/faults/audit API 和 SSE/WS。压力模式 100 devices、1000 interfaces、500 active alerts、10000 syslogs、20 charts，至少 100 次故障事件，去重/根因正确，表格/拓扑可操作。

为独立验收提供一个仅用于隔离测试的稳定 API 契约（不是伪造数据）：
GET /api/health；GET /api/devices → 数组或 {devices:数组}；GET /api/interfaces；GET /api/alerts；GET /api/syslog；GET /api/audit；GET /api/topology → {nodes,links}。
POST /api/faults JSON {type:"noBuffers",deviceId,interfaceId} → {id}；POST /api/faults/:id/restore。
POST /api/test/stress → 使用同一个真实模拟引擎扩展到以上压力规模，返回规模；GET /api/test/state → 当前真实 counts、tick、pendingFaults、activeAlerts（不得用固定值）。
POST /api/test/step {seconds:10} 使用同一模拟引擎确定性推进，便于验证增量、故障与恢复。正常界面必须仍可持续实时运行，测试接口不能替代实际逻辑。

自主验证重点：noBuffers 与低带宽高 PPS；核心/WAN 故障依赖根因与恢复；配置修改/Diff/审计/回滚；压力模式筛选/切页/图表/拓扑。最终逐项 PASS/FAIL/NOT VERIFIED：启动、构建、设备、接口、计数器、实时流、拓扑、曲线、PPS、CRC、noBuffers、丢包、规则、去重、恢复、Syslog、OSPF/BGP、故障、RCA、配置、Diff、审计、持久化、重连、压力、控制台、性能。未测不得宣称 PASS。Bonus：IPAM、Dashboard Builder。

独立验收字段（同一引擎的真实数据，不能单独生成）：接口使用 id/deviceId/speed（bps）/rxBytes/txBytes/rxPackets/txPackets/rxBps/txBps/rxPps/txPps/crc/noBuffers/utilization（0～1）。告警使用 id/deviceId/interfaceId/rule/fingerprint/state/rootCauseDeviceId，状态字符串沿用上述定义。
POST /api/alerts/:id/ack；GET /api/config/:deviceId → {content,versionId}；PUT 同路径 {content,reason} → 新版本；GET /api/config/:deviceId/diff?from=版本&to=版本 → {lines:[{kind:"added"|"removed"|"unchanged",text}]}；POST /api/config/:deviceId/rollback {versionId}。审计操作包含 deviceId/action（config.rollback）。
仅隔离 Debug 测试模式 POST /api/test/identity {role:"viewer"|"operator"|"admin"} 返回 {token}，Bearer 鉴权由服务端统一处理。正常 UI 也必须使用同一权限判定，测试身份入口不得用于公开部署。
