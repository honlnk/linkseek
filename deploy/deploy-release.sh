#!/bin/sh
# linkseek 发布脚本（借鉴 jiyacr 方案 §9-2，裁剪适配单项目形态）
# 用法: APP_VERSION=<x.y.z> [ALLOW_ROLLBACK=true|false] [DOCKERHUB_USERNAME=.. DOCKERHUB_TOKEN=..] sh deploy-release.sh
#
# 常规入口：.github/workflows/release.yml 在打 v* tag 后 rsync 本脚本到服务器并经 ssh 调用，
# 脚本版本与 tag 严格同步；应急时也可在服务器上手动执行，效果等同。
# 版本钉定：服务器 .env 的 APP_IMAGE_TAG，docker-compose.prod.yml 以 ${APP_IMAGE_TAG:-latest} 引用。
# 回滚边界：只回滚镜像，不回滚数据库迁移（迁移在容器启动时执行，见结尾失败提示）。
set -u

COMPOSE_FILE=${COMPOSE_FILE:-docker-compose.prod.yml}
COMPOSE_ENV_FILE=${COMPOSE_ENV_FILE:-.env}
HEALTHCHECK_TRIES=${HEALTHCHECK_TRIES:-36}
HEALTHCHECK_DELAY=${HEALTHCHECK_DELAY:-5}
MIN_FREE_MB=${MIN_FREE_MB:-2048}
STATE_DIR=${STATE_DIR:-.}
STATE_FILE_NAME=${STATE_FILE_NAME:-.last-deployed-linkseek}
ALLOW_ROLLBACK=${ALLOW_ROLLBACK:-true}
BACKUP_DIR=${BACKUP_DIR:-backups}
BACKUP_KEEP=5

fail() { echo "[deploy-release] $*" >&2; exit 1; }

# ---------- 入参校验 ----------
[ -n "${APP_VERSION:-}" ] || fail "缺少 APP_VERSION（如 APP_VERSION=0.2.0）"
echo "$APP_VERSION" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$' || fail "APP_VERSION 非语义化: $APP_VERSION"
cd "$(dirname "$0")"

# ---------- 前置：磁盘水位 ----------
FREE_MB=$(df -Pm / | awk 'NR==2 {print $4}')
[ "$FREE_MB" -ge "$MIN_FREE_MB" ] || fail "磁盘余量不足：/ 剩 ${FREE_MB}MB < ${MIN_FREE_MB}MB，拒绝部署"

# ---------- 前置：Docker Hub 登录（消除匿名拉取限流；未注入则沿用服务器已保存登录态） ----------
if [ -n "${DOCKERHUB_USERNAME:-}" ] && [ -n "${DOCKERHUB_TOKEN:-}" ]; then
  echo "$DOCKERHUB_TOKEN" | docker login --username "$DOCKERHUB_USERNAME" --password-stdin >/dev/null 2>&1 \
    || fail "docker login Docker Hub 失败"
  echo "[deploy-release] Docker Hub 已登录（凭据由流水线注入）"
else
  echo "[deploy-release] 未提供 Docker Hub 凭据，沿用服务器已保存登录态（或匿名拉取）"
fi

# ---------- 记录旧版本（状态文件优先；读不到则从运行容器镜像名兜底） ----------
STATE_FILE="$STATE_DIR/$STATE_FILE_NAME"
OLD_VERSION=""
[ -f "$STATE_FILE" ] && OLD_VERSION=$(cat "$STATE_FILE")
if [ -z "$OLD_VERSION" ]; then
  OLD_VERSION=$(docker inspect -f '{{.Config.Image}}' linkseek-app 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+$' || true)
fi
echo "[deploy-release] APP_VERSION=$APP_VERSION OLD_VERSION=${OLD_VERSION:-<无>} ALLOW_ROLLBACK=$ALLOW_ROLLBACK"

update_env_value() {
  key="$1"; value="$2"
  if grep -q "^${key}=" "$COMPOSE_ENV_FILE"; then
    sed -i.bak "s#^${key}=.*#${key}=${value}#" "$COMPOSE_ENV_FILE" && rm -f "$COMPOSE_ENV_FILE.bak"
  else
    echo "${key}=${value}" >> "$COMPOSE_ENV_FILE"
  fi
}

dc="docker compose --env-file $COMPOSE_ENV_FILE -f $COMPOSE_FILE"

# ---------- 部署前 mysqldump 备份（无条件执行，保留最近 5 份） ----------
# 先落临时文件校验退出码与非空，再压缩——避免 mysqldump 失败但 gzip 成功导致空备份蒙混过关
mkdir -p "$BACKUP_DIR"
BACKUP_FILE="$BACKUP_DIR/pre-release-$(date +%Y%m%d-%H%M%S).sql.gz"
TMP_SQL="$BACKUP_DIR/.dump.tmp.$$"
echo "[deploy-release] mysqldump → $BACKUP_FILE"
if ! docker exec linkseek-mysql sh -c 'exec mysqldump -uroot -p"$MYSQL_ROOT_PASSWORD" --single-transaction --routines --triggers linkseek' > "$TMP_SQL"; then
  rm -f "$TMP_SQL"; fail "mysqldump 失败，拒绝继续"
fi
[ -s "$TMP_SQL" ] || { rm -f "$TMP_SQL"; fail "mysqldump 输出为空，拒绝继续"; }
gzip -c "$TMP_SQL" > "$BACKUP_FILE" && rm -f "$TMP_SQL"
ls -1t "$BACKUP_DIR"/pre-release-*.sql.gz 2>/dev/null | tail -n +"$((BACKUP_KEEP + 1))" | xargs -r rm -f

wait_url() {
  name="$1"; url="$2"; host="${url#https://}"; host="${host%%/*}"
  i=1
  while [ "$i" -le "$HEALTHCHECK_TRIES" ]; do
    # --resolve 打本机 443，走 honlnk-gateway → linkseek-gateway → app 全链路
    if curl -fsS --connect-timeout 3 --max-time 10 --resolve "${host}:443:127.0.0.1" "$url" >/dev/null 2>&1; then
      echo "[healthcheck] OK $name"; return 0
    fi
    echo "[healthcheck] waiting $name ($i/$HEALTHCHECK_TRIES)"
    i=$((i+1)); sleep "$HEALTHCHECK_DELAY"
  done
  echo "[healthcheck] FAILED $name: $url" >&2
  return 1
}

dump_failure_logs() {
  echo "===== 失败诊断：容器日志尾部 =====" >&2
  for c in linkseek-app linkseek-gateway; do
    echo "--- $c ---"; docker logs --tail=80 "$c" >&2 2>&1 || true
  done
  $dc ps >&2 || true
}

# ---------- 部署（只动 app + gateway，mysql/searxng/browser-fetch 不跟发） ----------
update_env_value APP_IMAGE_TAG "$APP_VERSION"
$dc config >/dev/null || { dump_failure_logs; fail "compose config 校验失败"; }
$dc pull app || { dump_failure_logs; fail "镜像拉取失败"; }
$dc up -d app gateway || { dump_failure_logs; fail "容器启动失败"; }

# bind-mount 的 nginx conf 变更不触发容器重建，靠 reload 感知；
# nginx -t 不过则跳过（运行中的旧配置不受影响），告警待人工处置
if docker exec linkseek-gateway nginx -t 2>/dev/null; then
  docker exec linkseek-gateway nginx -s reload && echo "[deploy-release] linkseek-gateway 配置已 reload"
else
  echo "[deploy-release] ⚠️ linkseek-gateway nginx -t 未通过，跳过 reload（旧配置仍在运行，请人工检查 nginx/ 下文件）" >&2
fi

# ---------- 健康检查 ----------
HEALTH_OK=true
wait_url "linkseek-health" "https://linkseek.honlnk.com/health" || HEALTH_OK=false
wait_url "admin-spa"       "https://admin.linkseek.honlnk.com/"  || HEALTH_OK=false

if [ "$HEALTH_OK" != "true" ]; then
  dump_failure_logs
  if [ "$ALLOW_ROLLBACK" = "true" ] && [ -n "$OLD_VERSION" ]; then
    echo "[deploy-release] 健康检查失败，自动回滚到 $OLD_VERSION" >&2
    update_env_value APP_IMAGE_TAG "$OLD_VERSION"
    $dc pull app && $dc up -d app gateway
    echo "[deploy-release] 已回滚到 $OLD_VERSION（请人工核验健康状态）" >&2
  else
    echo "[deploy-release] 健康检查失败且无法自动回滚，保持失败现场待人工处置" >&2
    echo "（若本次发布含数据库迁移，注意服务器可能处于旧代码+新 schema 混合态，先看 docker logs linkseek-app 的迁移日志）" >&2
  fi
  exit 1
fi

echo "$APP_VERSION" > "$STATE_FILE"
$dc ps
echo "[deploy-release] ✅ linkseek $APP_VERSION 发布完成"
