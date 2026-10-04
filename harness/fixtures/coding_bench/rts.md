实现原创大型可玩 RTS：IRON DOMINION。从零创建工程在 {{PROJECT_DIR}}，不读取、复制或修改 LZCore 仓库、凭据或服务配置。优先 TypeScript/React/Vite/Three.js，允许 Canvas/WebGL。React 仅做 UI；独立固定步长模拟引擎，不要每单位高频 React 组件。不能做动画冒充玩法或因困难删除核心能力。

必须有 npm test 和 npm run build，后台预览 {{PREVIEW_ORIGIN}}，PID 写 server.pid；常驻进程标准输入输出重定向，不能阻塞工具。阶段性保持可运行，测试失败自主修复。实际 browser.manage 验证操作及控制台，策略拦截必须报告且禁止扩大权限。

完整 Skirmish vs AI 闭环：采集→建造→生产→扩张→科技→侦察→战斗→摧毁敌方核心→胜利，自己的核心摧毁→失败。
- 至少 128×128 逻辑 Grid；固定测试地图和 Seed 程序地图（同 Seed 一致），公平出生点、资源距离、通路连通、地形 Ground/Rock/Water或Hazard/Cliff/ResourceField、狭窄通道。
- RTS Camera：边缘滚动、WASD/箭头、鼠标拖动、缩放。单选、框选、Shift 添加、双击同类。Ctrl+1～9设组，数字选组，双击聚焦。
- 命令 Move/Attack/AttackMove/Stop/Hold/Patrol；右键依目标 Move/Attack/Gather/Repair/Build。单位有 ID、类型、owner、真实 position/velocity、HP/maxHP、armor、speed、radius、sight、range、damage、cooldown、target。
- 两种有限资源 Alloy/Energy。工人 Gather→Carry→Return→Deposit→Repeat，并能施工/维修；资源守恒，不可凭空增长，不可负值，耗尽自动停或换目标。
- 建筑 CommandCore、Depot、Barracks、Factory、PowerGenerator、Turret、ResearchLab。放置预览/合法检查/地形和碰撞；工人实际施工、进度/时间；取消部分退款但不能复制资源。
- Population/Supply、生产队列、进度/取消/退款、占人口、合法出口；堵塞时等待或合法位置生成，不穿建筑或施工中的合理障碍。
- 至少 Worker/Scout/Infantry/Heavy/Ranged，各有不同属性/角色。有限范围索敌、射程、冷却、装甲、伤害、死亡、合理 projectile 命中。AttackMove遇敌攻击、消失继续移动，集火死亡后重新索敌。默认无友伤。
- Fog 三态 Unexplored/Explored/Visible，动态由单位/建筑视野更新，不在每帧全图昂贵扫描；未见敌军不出现在世界/UI/小地图。小地图显示地形、友军、可见敌军、视窗、警报，点击定位。
- 真实 A*/JPS/FlowField/层次寻路，考虑地形/建筑/动态单位；Path Request Queue 每 tick 有预算，禁止每单位每帧全图 A*。200+同时移动，独立编队 Slot、局部避障/Separation、通过 choke、不永久拥堵、卡住重规划、新建筑使路径失效时重规划。Spatial Hash/Uniform Grid/Quadtree 加速邻居/目标/碰撞，禁止每帧所有单位 O(N²)。Worker通信若用必须真实。
- 固定 Simulation Tick 与 Render/AI/Economy 分离；AI 真正遵守资源、施工、生产队列、Fog，经营/扩人口/建兵营/产兵/侦察/防守/进攻状态，不能固定时间免费刷兵或上帝视角。
- 科技 Tier1→Tier2→Advanced，研究 Cost/Time/Prerequisite；武器/装甲/经济升级必须实际改变属性。
- HUD资源/人口/选择单位/命令/生产/小地图；多选统计、按选择类型显示合法命令。现代战术风，世界为主体、不堆霓虹巨卡按钮。原创/程序化声音包含选择/移动/攻击/施工/死亡/警报。
- 警报基地/单位受袭、资源耗尽、建筑完成、研究完成，可点击定位。单位/建筑类型可区分、选中圈、受伤/选中/悬浮时血条；Idle/Move/Attack/Death程序动画；死亡从模拟/渲染/空间索引/选择/目标引用移除，无失效引用。
- 完整比赛统计 Duration/Gathered/Produced/Lost/Killed/Buildings/Damage；Save/Load 保存地图种子、单位、建筑、资源、研究、队列、AI、Fog、时间后正常续跑。Replay为Bonus（Seed+Commands+Timestamps可重现）。
- Debug Mode 有 Spawn/AddResources/Reveal/Kill，仅 Debug；F3显示真实 FPS/TPS/单位/建筑/寻路队列/AI耗时/RenderCalls/Triangles/MemoryEstimate，禁假 FPS。
- 一键100v100 Battle Stress Scenario；200/300单位、50建筑、多战斗、Fog/AI/寻路同时运行；500单位为Bonus。200群移不冻结数秒，100v100可操作；长时间队列清空、引用/投射物/内存不无限增长。

为独立验收提供 Debug 独立模块（不取代正常规则）：源码 {{PROJECT_DIR}}/src/engine.js 或 engine.ts，导出 createGame({seed,debug})，返回 step(seconds)、snapshot()、command({type,unitIds,target})、debugScenario({friendly:100,enemy:100})、save()、load(state)。API 按实际引擎实现，snapshot 至少 {tick,units,buildings,resources,pathQueue,stats}。网页 expose 同一个引擎 window.game 仅当显式 ?debug=1，正常模式不暴露 debug 操作。可另有最小适配器，但不能独立造假验收状态。

最终真实验证并逐项 PASS/FAIL/NOT VERIFIED：启动/构建、地图/相同Seed、Camera、选择/组、Move/AttackMove、工人采集/交回、资源守恒、放置/施工、生产/人口、寻路/队列/避障/编队/choke、战斗/投射物/重新索敌、Fog/小地图、AI经营/生产/侦察/进攻、科技/升级、胜败、保存恢复、100v100、200群移、长时间清理、控制台/性能。不要把自编测试成功当作所有外部验收成功。

独立验收命令契约：command 的 type 使用 move/attack/attackMove/stop/hold/patrol/gather/build/train/research（允许内部转换命名）；target 为逻辑 Grid {x,y}，或具体目标 ID。snapshot.units 的 position 或 pos 为 Grid 坐标；owner 为 0/1；pathQueue 为待办数组或实际长度；snapshot.projectiles 为当前存活投射物数组。资源按 owner 提供包含 alloy/energy 的数组。getState() 为隔离 Debug 的完整只读观测，fogs 为每个阵营的 {explored,visible} 数组，save/load 必须完整保留。
debugScenario({friendly,enemy}) 创建可真实交战的压力场景，不能只有摆放；friendly=200,enemy=0 可用于群移。Debug 数据使用同一寻路/战斗/经济/清理代码。Saved RNG 和 AI 状态必须支持同命令的确定性接续。所有 Debug 入口只在隔离测试模式启用。
