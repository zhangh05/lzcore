# 部署配置与验收

记录、对象、队列和事件总线分开配置。环境文件、凭据、Provider 配置、工作区和备份不进入 Git/镜像。执行部署、恢复或删备份前应确认用户授权的环境和动作。

## 完整生产 profile

deployment/compose.production.yml 包含 Gunicorn、worker、Nginx、TLS 网关、PostgreSQL、Redis、S3 兼容对象存储及 Prometheus/Alertmanager/Grafana。以 deployment/.env.production.example 创建环境与秘密/TLS 文件，先校验再启动。

```bash
docker compose --env-file /etc/lzcore/production.env -f deployment/compose.production.yml config
docker compose --env-file /etc/lzcore/production.env -f deployment/compose.production.yml up -d --build
docker compose --env-file /etc/lzcore/production.env -f deployment/compose.production.yml exec backend python scripts/production_preflight.py --live
```

公网入口仅 TLS，前后端端口在内部网络；认证秘密以文件挂载。要求 Python 强隔离时需 Docker 与已核验镜像摘要，缺失则拒绝；优先专用 rootless socket，不开放无认证 Docker TCP。

默认单 Web 进程/单 worker，尚未迁入数据库/对象存储的文件共享 lzcore-data。扩副本前验证共享锁语义和分布式集成，不把 Redis 广播等同于任意横向扩展。

## 监听与认证

默认 loopback。LZCORE_LISTEN_HOST/--host 非回环时，validate_network_listener 要求有效认证：

- LZCORE_AUTH_ENABLED=true 与 LZCORE_API_TOKEN 或 LZCORE_API_TOKEN_FILE。
- LZCORE_LOGIN_USERNAME 与 LZCORE_LOGIN_PASSWORD 或 LZCORE_LOGIN_PASSWORD_FILE。
- LZCORE_IDENTITY_ENABLED=true 并配置身份模式。

隔离开发/容器测试可显式 LZCORE_ALLOW_UNAUTHENTICATED_NETWORK=true，此覆盖会产生严重警告，不是生产默认。

OIDC 用 LZCORE_OIDC_ENABLED、HTTPS issuer、client ID/secret 文件与 LZCORE_PUBLIC_URL；账号和工作区授权先由管理员创建，不自动赋权。密码登录可作为恢复路径，OIDC 不替代资源/角色授权。

```bash
docker compose --env-file /etc/lzcore/production.env -f deployment/compose.production.yml -f deployment/compose.oidc.yml up -d
```

## 单服务器 profile

deployment/compose.server.yml 使用本机文件记录、工作区和 Provider 配置，管理 backend/worker/frontend；入口默认 5273，后端 8011 仅 loopback。保留 root-only .env.local，配置 socket GID，目录允许容器 uid/gid 10001 写入。

```bash
printf 'LZCORE_DOCKER_SOCKET_GID=%s\n' "$(stat -c '%g' /var/run/docker.sock)" > deployment/.env
chown -R 10001:10001 workspaces config/providers
bash scripts/deploy_server_compose.sh
docker compose -f deployment/compose.server.yml ps
```

部署统一使用脚本重建三服务，核对 backend/worker 同一镜像并检查就绪，不只更新某一容器。不要同时运行 start.sh 或同端口旧 screen 进程。发布后至少核对：

```bash
git rev-parse HEAD
docker compose -f deployment/compose.server.yml ps
curl -fsS http://127.0.0.1:8011/api/health
curl -fsS http://127.0.0.1:5273/api/health
curl -fsSI http://127.0.0.1:5273/
docker compose -f deployment/compose.server.yml exec -T backend python -m pytest -q harness/test_goal_loop.py harness/test_network_read_recovery.py
```

容器内测试或 liveness 不能替代实际前端和受影响业务路径。

## 适配器和作业

```bash
export LZCORE_RECORD_STORE_MODE=postgres
export LZCORE_DATABASE_URL='postgresql://...'
export LZCORE_OBJECT_STORE_MODE=s3
export LZCORE_OBJECT_STORE_BUCKET=lzcore-artifacts
export LZCORE_OBJECT_STORE_PREFIX=production
export LZCORE_QUEUE_MODE=redis
export LZCORE_QUEUE_URL='redis://...'
export LZCORE_EVENT_BUS_MODE=redis
export LZCORE_EVENT_BUS_URL='redis://...'
```

Redis worker 使用可续租 lease，过期回队增加 attempt。LZCORE_JOB_LEASE_SECONDS 默认示例 120、LZCORE_WORKER_STALE_SECONDS 180，LZCORE_WORKER_ID 指定身份。status 显示 heartbeat/attempt/stale。

队列 at-least-once：外部副作用之后、ack 之前可能丢租约；handler 应以 job_id/step_id 建幂等键。未知写入由账本 read-back/reconcile，不因 worker 重启盲目重复。

## 健康和观测

/api/health 是 liveness；/api/ready 验证存储可写/连通、队列及 worker heartbeat，必要依赖不可用返回 503。/metrics 为 Prometheus，/api/metrics 为 JSON，认证启用时需要对应凭据。标签使用路由模板，避免用户 ID 导致无限基数。

deployment/observability 包含规则和初始面板；上线前替换 Alertmanager 占位接收器。事故路径见 [处置手册](OPERATIONS_RUNBOOK.md)。

## 备份与恢复

```bash
python3 scripts/backup_cli.py create
python3 scripts/backup_cli.py list
python3 scripts/backup_cli.py verify /path/to/backup.tar.gz
python3 scripts/backup_cli.py restore backup-... --confirm RESTORE
python3 scripts/backup_cli.py prune --keep 10
```

归档记录 SHA-256，复制中变动会重试。恢复拒绝穿越、链接、设备文件、重复路径、错误摘要/总数；先将当前数据移至回退目录再切换。默认 .lzcore-backups 在工作区根旁，LZCORE_BACKUP_DIR 可指定加密异地存储。API 管理入口在 identity 下要求管理员。

## 不可变程序槽

```bash
npm --prefix frontend run build
python3 scripts/release_slots.py --release-root /opt/lzcore stage 3.3.1
python3 scripts/release_slots.py --release-root /opt/lzcore activate 3.3.1 --health-url http://127.0.0.1:8011/api/ready
python3 scripts/release_slots.py --release-root /opt/lzcore rollback
```

服务从 /opt/lzcore/current 执行，符号链接原子切换并保留上一槽；readiness 失败自动切回。环境、数据、日志、虚拟环境和 Git 元数据不复制到槽，数据在程序目录之外。Windows Release 重建是独立发行流程，见 [WINDOWS](WINDOWS.md)。
