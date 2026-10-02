# 身份、组织与工作区

组织、用户、成员关系由 /api/identity/* 管理，工作区由 /api/workspaces/* 管理。每次资源访问使用服务端验证的 workspace_id 和认证主体，UI 路由或可猜测资源 ID 不授权访问。

HTTP 从 path、query、JSON、multipart 统一解析工作区字段；重复来源不一致返回 workspace_id_conflict。WebSocket 在读取数据和解析 Skill 前绑定 storage principal，每次工作区操作重新读取用户 enabled/role/工作区列表。禁用或删除账号不能保留旧长连接权限。

API token 使用独立 api-token principal，不落入匿名存储。角色与 workspace 可见性只是一层；工具仍检查 caller、policy 和扩展资源范围。可见工作区不等于可写设备，网络写入需要当前发布 Skill 范围及设备账号权限。

客户端切换用户/工作区时释放旧传输所有权，旧回调不得写进新身份 store。服务端任务不因页面离开而取消。详见 [API](API.md) 和 [前端](FRONTEND.md)。
