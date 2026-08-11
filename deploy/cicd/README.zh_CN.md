# miseStudio 生产环境 CI/CD

生产代码位于 `main` 分支。`CI` 工作流成功后，`Deploy production` 会：

1. 使用 Buildx 分别构建 Linux AMD64 的应用镜像和 Web 镜像。
2. 使用 GitHub Actions 缓存加速后续构建。
3. 把两个镜像打包并通过 New API 同款 `deploy` 用户上传到服务器。
4. 调用 `/usr/local/sbin/mise-studio-deploy` 获取部署锁并备份 PostgreSQL。
5. 使用新应用镜像执行 Alembic 数据库迁移。
6. 只重建 `api`、`web`、`billing-worker` 和 `media-cleanup`，不重建 PostgreSQL、Redis、Caddy 或 New API 容器。
7. 验证应用、Web、后台进程、New API 内网连接和公网域名。
8. 新版本启动失败或健康检查失败时，自动恢复上一组应用/Web 镜像。

仓库需要配置以下 GitHub Actions Secrets：

- `DEPLOY_HOST`：`154.44.1.62`
- `DEPLOY_USER`：`deploy`
- `DEPLOY_SSH_KEY`：New API CI/CD 使用的专用部署私钥
- `DEPLOY_KNOWN_HOSTS`：服务器 SSH 主机公钥记录

服务器固定文件：

- `/opt/miseStudio/docker-compose.yml`
- `/opt/miseStudio/.release.env`
- `/opt/miseStudio/shared/.env`
- `/usr/local/sbin/mise-studio-deploy`
- `/home/deploy/uploads/`

每次发布前的数据库备份位于：

```text
/opt/miseStudio/backups/deploy/<UTC时间>-<提交SHA前12位>/mise-studio.pg_dump
```

媒体项目卷保持不变。`media-cleanup` 每小时清理一次超过 24 小时的视频文件，图片、音频、项目 JSON 和其他元数据不会被删除。
