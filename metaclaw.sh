#!/usr/bin/env bash

# Metaclaw 生产启动脚本
# 用法: ./metaclaw.sh [start|connect|stop|restart|status]

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PID_FILE="$HOME/.metaclaw/metaclaw.pid"
LOG_FILE="$HOME/.metaclaw/metaclaw.log"
NODE_BIN="node"
APP_ENTRY="$SCRIPT_DIR/dist/index.js"
BUILD_STAMP="$SCRIPT_DIR/dist/index.js"

# 确保目录存在
mkdir -p "$HOME/.metaclaw"

# 颜色输出
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

log_info() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

needs_rebuild() {
    if [ ! -f "$BUILD_STAMP" ]; then
        return 0
    fi

    local newer_file
    newer_file=$(find \
        "$SCRIPT_DIR/src" \
        "$SCRIPT_DIR/package.json" \
        "$SCRIPT_DIR/package-lock.json" \
        "$SCRIPT_DIR/tsconfig.json" \
        "$SCRIPT_DIR/tsup.config.ts" \
        -type f -newer "$BUILD_STAMP" 2>/dev/null | head -n 1 || true)

    [ -n "$newer_file" ]
}

ensure_built() {
    if [ ! -f "$APP_ENTRY" ]; then
        log_warn "未找到构建产物，正在自动构建..."
    elif needs_rebuild; then
        log_info "检测到源码更新，正在自动构建..."
    else
        return 0
    fi

    (cd "$SCRIPT_DIR" && npm run build)
}

# 查找当前项目目录下运行的 Metaclaw 实例。只依赖 PID 文件会漏掉通过
# `npm start` 或 `node dist/index.js` 手动启动的旧实例。
find_running_pids() {
    local pid
    local args
    ps -eo pid=,args= | while read -r pid args; do
        if [ "$pid" = "$$" ]; then
            continue
        fi

        case "$args" in
            *node*"dist/index.js"*|*node*"$APP_ENTRY"*) ;;
            *) continue ;;
        esac

        case "$args" in
            *"--connect"*) continue ;;
        esac

        local cwd
        cwd=$(readlink "/proc/$pid/cwd" 2>/dev/null || true)
        if [ "$cwd" = "$SCRIPT_DIR" ]; then
            echo "$pid"
            continue
        fi

        case "$args" in
            *"$APP_ENTRY"*) echo "$pid" ;;
        esac
    done | sort -n | uniq
}

# 检查进程是否运行
is_running() {
    if [ -n "$(find_running_pids)" ]; then
        return 0
    fi

    return 1
}

# 启动
start() {
    if is_running; then
        log_warn "Metaclaw 已在运行 (PID: $(find_running_pids | tr '\n' ' '))"
        return 1
    fi

    log_info "启动 Metaclaw..."

    ensure_built

    # 前台启动（TUI 需要 TTY）
    echo "$$" > "$PID_FILE"
    trap 'rm -f "$PID_FILE"' EXIT
    exec "$NODE_BIN" "$APP_ENTRY"
}

# 连接到已运行的 Metaclaw Gateway
connect() {
    if ! is_running; then
        log_error "Metaclaw 未运行，请先执行 ./metaclaw.sh start"
        return 1
    fi

    ensure_built
    exec "$NODE_BIN" "$APP_ENTRY" --connect
}

# 停止
stop() {
    local pids
    pids=$(find_running_pids)
    if [ -z "$pids" ]; then
        log_warn "Metaclaw 未运行"
        rm -f "$PID_FILE"
        return 1
    fi

    log_info "停止 Metaclaw (PID: $(echo "$pids" | tr '\n' ' '))..."

    # 发送 SIGTERM
    for pid in $pids; do
        kill "$pid" 2>/dev/null || true
    done

    # 等待进程退出
    local count=0
    while [ -n "$(find_running_pids)" ]; do
        sleep 1
        count=$((count + 1))
        if [ $count -ge 10 ]; then
            log_warn "进程未响应，强制终止..."
            for pid in $(find_running_pids); do
                kill -9 "$pid" 2>/dev/null || true
            done
            break
        fi
    done

    rm -f "$PID_FILE"
    log_info "Metaclaw 已停止"
}

# 重启
restart() {
    log_info "重启 Metaclaw..."
    if is_running; then
        stop
    else
        log_warn "Metaclaw 未运行，直接启动..."
    fi
    sleep 1
    start
}

# 状态
status() {
    if is_running; then
        local pids
        pids=$(find_running_pids)
        log_info "Metaclaw 正在运行 (PID: $(echo "$pids" | tr '\n' ' '))"

        # 显示进程信息
        for pid in $pids; do
            ps -p "$pid" -o pid,ppid,%cpu,%mem,etime,command | tail -n +2
        done

        # 显示最近日志
        if [ -f "$LOG_FILE" ]; then
            echo ""
            log_info "最近日志 (最后 10 行):"
            tail -n 10 "$LOG_FILE"
        fi
    else
        log_warn "Metaclaw 未运行"
        return 1
    fi
}

# 查看日志
logs() {
    if [ ! -f "$LOG_FILE" ]; then
        log_error "日志文件不存在: $LOG_FILE"
        exit 1
    fi

    if [ "$1" = "-f" ] || [ "$1" = "--follow" ]; then
        tail -f "$LOG_FILE"
    else
        tail -n 50 "$LOG_FILE"
    fi
}

# 安装为用户级 systemd 服务
install_service() {
    local systemd_dir="$HOME/.config/systemd/user"
    local service_file="$systemd_dir/metaclaw.service"

    mkdir -p "$systemd_dir"
    cat > "$service_file" <<EOF
[Unit]
Description=MetaClaw Gateway
After=network.target

[Service]
Type=simple
WorkingDirectory=$SCRIPT_DIR
ExecStart=$NODE_BIN $APP_ENTRY
Restart=on-failure
RestartSec=3
Environment=METACLAW_HOME=$HOME/.metaclaw

[Install]
WantedBy=default.target
EOF

    log_info "已安装用户级服务: $service_file"
    if command -v systemctl >/dev/null 2>&1; then
        systemctl --user daemon-reload 2>/dev/null || true
        log_info "可执行: systemctl --user enable --now metaclaw.service"
    fi
}

# 主逻辑
case "${1:-}" in
    start)
        start
        ;;
    connect)
        connect
        ;;
    stop)
        stop
        ;;
    restart)
        restart
        ;;
    status)
        status
        ;;
    logs)
        logs "${2:-}"
        ;;
    install)
        ensure_built
        install_service
        ;;
    gateway)
        shift
        case "${1:-run}" in
            install)
                ensure_built
                install_service
                ;;
            start)
                start
                ;;
            stop)
                stop
                ;;
            restart)
                restart
                ;;
            status)
                status
                ;;
            run|setup|doctor|pairing|"")
                ensure_built
                exec "$NODE_BIN" "$APP_ENTRY" gateway "$@"
                ;;
            *)
                ensure_built
                exec "$NODE_BIN" "$APP_ENTRY" gateway "$@"
                ;;
        esac
        ;;
    *)
        echo "用法: $0 {start|connect|stop|restart|status|logs [-f]|install|gateway [setup|run|install|start|stop|restart|status|doctor|pairing]}"
        echo ""
        echo "命令:"
        echo "  start    - 启动 Metaclaw"
        echo "  connect  - 连接到当前运行的 Metaclaw Gateway"
        echo "  stop     - 停止 Metaclaw"
        echo "  restart  - 重启 Metaclaw"
        echo "  status   - 查看运行状态"
        echo "  logs     - 查看日志 (加 -f 实时跟踪)"
        echo "  install  - 安装用户级 systemd 服务"
        echo "  gateway  - Gateway 子命令，例如 gateway setup / gateway pairing list / gateway status"
        exit 1
        ;;
esac
