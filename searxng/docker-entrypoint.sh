#!/bin/sh
# SearXNG 自定义 entrypoint：启动前把 settings.yml 中的占位符替换为环境变量值。
#
# 解决问题：SearXNG 的 settings.yml 不支持 ${VAR} 插值，但本地和生产需要不同的
# 代理地址（outgoing.proxies）。此脚本在容器启动时用 sed 替换占位符，生成最终
# 配置文件写到可写路径，再 exec 原始 entrypoint。
#
# 用法（docker-compose）:
#   volumes:
#     - ./searxng/settings.yml:/etc/searxng/settings.template.yml:ro
#     - ./searxng/docker-entrypoint.sh:/docker-entrypoint.sh:ro
#   environment:
#     - SEARXNG_PROXY=http://host.docker.internal:7897
#   entrypoint: /bin/sh /docker-entrypoint.sh
set -eu

TEMPLATE="/etc/searxng/settings.template.yml"
TARGET="/etc/searxng/settings.yml"

if [ ! -f "$TEMPLATE" ]; then
  echo "!!! $TEMPLATE not found, falling back to stock entrypoint" >&2
  exec /usr/local/searxng/entrypoint.sh "$@"
fi

# 占位符 → 环境变量值（缺失时给出明确报错，避免静默写入空值导致代理失效）
PROXY="${SEARXNG_PROXY:?SEARXNG_PROXY environment variable is required}"

# 模板里是 YAML 裸值占位符 __SEARXNG_PROXY__，替换为带引号的 URL
# （加引号确保特殊字符如 : / 不会触发 YAML 解析问题）
sed "s|__SEARXNG_PROXY__|\"${PROXY}\"|g" "$TEMPLATE" > "$TARGET"

echo "... settings.yml generated with SEARXNG_PROXY=${PROXY}"

exec /usr/local/searxng/entrypoint.sh "$@"
