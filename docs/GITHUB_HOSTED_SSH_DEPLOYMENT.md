# GitHub 托管 Runner 通过 SSH 部署 Aipany

这条链路不在 VPS 上安装或常驻 GitHub Actions Runner：

```text
push / 手动触发
        ↓
GitHub-hosted ubuntu-latest
        ↓  SSH + rsync（固定主机公钥、专用部署密钥）
Aipany VPS
        ↓
Docker Compose 构建、切换、健康检查、失败回滚
```

生产工作流：`.github/workflows/deploy-production-ssh.yml`

远端激活脚本：`scripts/deploy-ssh-release.sh`

VPS 初始化脚本：`scripts/bootstrap-ssh-deploy-user.sh`

## 安全边界

- 不允许 SSH 密码登录工作流；
- 不使用 root 作为 GitHub 部署用户；
- 使用项目专用 Ed25519 密钥；
- GitHub 必须保存准确的 SSH Host Key，工作流不会使用 `StrictHostKeyChecking=no`；
- `.env` 永远不由 GitHub 上传，固定保存在 VPS 的部署根目录；
- 每个 Git SHA 上传到独立 release 目录；
- Docker Compose 固定使用 `-p aipany`，不会因 release 目录变化而新建数据库卷；
- 本地 `http://127.0.0.1:3000/health` 和公网 `/health` 都通过才算发布成功；
- 保留最近 5 个 release，失败时尝试恢复上一个 release；
- `AIPANY_SSH_DEPLOY_ENABLED` 未设为 `true` 时，main push 自动发布保持关闭，手动发布仍可使用。

> 部署用户加入 `docker` 组后具有接近 root 的容器管理能力。该 SSH 私钥应按生产部署凭据保护，只放在 GitHub `production` Environment Secret 中。

## 一、在 VPS 生成项目专用密钥

以下命令以 root 执行。把 `YOUR_VPS_HOST` 换成 GitHub Runner 实际连接的公网 IP 或域名；端口不是 22 时同时修改 `SSH_PORT`。

```bash
set -euo pipefail

SSH_HOST="YOUR_VPS_HOST"
SSH_PORT="22"
KEY_DIR="/root/aipany-github-deploy-key"

install -d -m 700 "$KEY_DIR"
ssh-keygen \
  -t ed25519 \
  -C "github-actions:b8vipvip/aipany" \
  -f "$KEY_DIR/id_ed25519" \
  -N ""

PUBLIC_KEY="$(cat "$KEY_DIR/id_ed25519.pub")"
```

## 二、准备部署用户和目录

服务器已经有 Aipany 仓库时，在仓库目录执行：

```bash
AIPANY_DEPLOY_PUBLIC_KEY="$PUBLIC_KEY" \
AIPANY_DEPLOY_USER="aipany-deploy" \
AIPANY_DEPLOY_PATH="/opt/aipany" \
AIPANY_SSH_HOST="$SSH_HOST" \
AIPANY_SSH_PORT="$SSH_PORT" \
bash scripts/bootstrap-ssh-deploy-user.sh
```

脚本会：

- 创建 `aipany-deploy`；
- 安装专用公钥；
- 加入 Docker 组；
- 准备 `/opt/aipany/.deploy/incoming` 和 `.deploy/releases`；
- 输出可直接保存到 GitHub 的 SSH Host Key。

首次发布前必须存在：

```text
/opt/aipany/.env
```

已有生产 `.env` 在其他目录时，复制并收紧权限：

```bash
install -m 600 -o aipany-deploy -g aipany-deploy \
  /原路径/.env \
  /opt/aipany/.env
```

不要把 `.env` 内容提交到 GitHub。

## 三、收集两个 Secret

### `AIPANY_SSH_PRIVATE_KEY`

在 VPS 查看一次私钥：

```bash
cat /root/aipany-github-deploy-key/id_ed25519
```

复制包括以下边界在内的全部内容：

```text
-----BEGIN OPENSSH PRIVATE KEY-----
...
-----END OPENSSH PRIVATE KEY-----
```

### `AIPANY_SSH_HOST_KEY`

初始化脚本会输出完整 known_hosts 行。也可以在 VPS 重新生成：

```bash
SSH_HOST="YOUR_VPS_HOST"
SSH_PORT="22"
HOST_KEY="$(awk '{print $1 " " $2}' /etc/ssh/ssh_host_ed25519_key.pub)"

if [[ "$SSH_PORT" == "22" ]]; then
  printf '%s %s\n' "$SSH_HOST" "$HOST_KEY"
else
  printf '[%s]:%s %s\n' "$SSH_HOST" "$SSH_PORT" "$HOST_KEY"
fi
```

Host Key 必须来自 VPS 本机 `/etc/ssh/ssh_host_ed25519_key.pub`，不要把未经验证的 `ssh-keyscan` 结果直接当作信任根。

## 四、配置 GitHub production Environment

进入：

```text
b8vipvip/aipany
→ Settings
→ Environments
→ New environment
→ production
```

在 `production` 中添加 Environment secrets：

| 名称 | 值 |
| --- | --- |
| `AIPANY_SSH_PRIVATE_KEY` | 上面的完整私钥 |
| `AIPANY_SSH_HOST_KEY` | 上面的完整 known_hosts 行 |

然后进入：

```text
Settings
→ Secrets and variables
→ Actions
→ Variables
```

添加 Repository variables：

| 名称 | 示例值 |
| --- | --- |
| `AIPANY_VPS_HOST` | VPS 公网 IP 或 SSH 域名 |
| `AIPANY_VPS_PORT` | `22` |
| `AIPANY_VPS_USER` | `aipany-deploy` |
| `AIPANY_DEPLOY_PATH` | `/opt/aipany` |
| `AIPANY_PRODUCTION_URL` | `https://aipany.mv3.cn` |

先不要创建 `AIPANY_SSH_DEPLOY_ENABLED`，先完成一次手动验收。

## 五、网络放行

GitHub-hosted Runner 必须能主动连接 VPS 的 SSH 端口。

检查：

- 腾讯云安全组已允许对应 SSH 端口；
- VPS 防火墙已允许该端口；
- `sshd` 正在监听；
- 部署用户只使用公钥，不设置登录密码。

GitHub-hosted Runner 的出口 IP 会变化。不能固定放行单个 Runner IP；需要使用可接受 GitHub 动态地址的网络策略，或后续接入私有网络/Tailscale 方案。

## 六、首次手动发布

进入：

```text
Actions
→ Deploy production via SSH
→ Run workflow
→ Branch: main
→ Run workflow
```

成功条件：

1. `Configure pinned SSH trust` 显示 `ssh-ready`；
2. release 上传到 `/opt/aipany/.deploy/incoming/<SHA>`；
3. Compose build 和 up 成功；
4. 本地网关健康检查成功；
5. `https://aipany.mv3.cn/health` 成功；
6. VPS 文件 `/opt/aipany/.deploy/current_sha` 等于本次 Git SHA。

VPS 验证：

```bash
cat /opt/aipany/.deploy/current_sha
tail -n 20 /opt/aipany/.deploy/history.log
docker compose \
  -p aipany \
  --env-file /opt/aipany/.env \
  -f /opt/aipany/current/deploy/docker-compose.yml \
  ps
curl -fsS http://127.0.0.1:3000/health; echo
curl -fsS https://aipany.mv3.cn/health; echo
```

## 七、打开 main 自动发布

首次手动发布成功后，在 Repository variables 新增：

```text
AIPANY_SSH_DEPLOY_ENABLED=true
```

此后每次 push/merge 到 `main` 都会由 GitHub-hosted Runner 主动 SSH 到 VPS 部署。

设为 `false` 或删除该变量即可暂停自动发布；手动 `Run workflow` 不受影响。

## 八、清理临时私钥副本

确认 GitHub Secret 已保存且首次发布成功后，从 VPS 删除生成时的私钥副本，只保留部署用户的公钥：

```bash
shred -u /root/aipany-github-deploy-key/id_ed25519 2>/dev/null \
  || rm -f /root/aipany-github-deploy-key/id_ed25519
rm -f /root/aipany-github-deploy-key/id_ed25519.pub
rmdir /root/aipany-github-deploy-key 2>/dev/null || true
```

不要删除：

```text
/home/aipany-deploy/.ssh/authorized_keys
```

## 与 self-hosted Runner 的区别

| 模式 | 发起连接 | VPS 常驻 Runner | VPS SSH 入站 |
| --- | --- | --- | --- |
| self-hosted Runner | VPS 主动长连接 GitHub | 需要 | 不用于 Actions |
| GitHub-hosted SSH 部署 | GitHub Runner 主动连接 VPS | 不需要 | 需要 |

Aipany 使用后一种模式后，不依赖 VPS 上的 GitHub Runner 服务。但 SuMeMe 的 Runner 是另一套部署链路，不能因为 Aipany 切换而直接停止。
