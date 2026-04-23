#!/usr/bin/env bash

# Metaclaw 生产启动脚本
# 用法: ./metaclaw.sh [start|stop|restart|status]

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

# 检查进程是否运行
is_running() {
    if [ -f "$PID_FILE" ]; then
        local pid=$(cat "$PID_FILE")
        if ps -p "$pid" > /dev/null 2>&1; then
            return 0
        fi
    fi
    return 1
}

# 启动
start() {
    if is_running; then
        log_warn "Metaclaw 已在运行 (PID: $(cat "$PID_FILE"))"
        return 1
    fi

    log_info "启动 Metaclaw..."

    ensure_built

    # 前台启动（TUI 需要 TTY）
    echo "$$" > "$PID_FILE"
    trap 'rm -f "$PID_FILE"' EXIT
    exec "$NODE_BIN" "$APP_ENTRY"
}

# 停止
stop() {
    if ! is_running; then
        log_warn "Metaclaw 未运行"
        return 1
    fi

    local pid=$(cat "$PID_FILE")
    log_info "停止 Metaclaw (PID: $pid)..."

    # 发送 SIGTERM
    kill "$pid" 2>/dev/null || true

    # 等待进程退出
    local count=0
    while ps -p "$pid" > /dev/null 2>&1; do
        sleep 1
        count=$((count + 1))
        if [ $count -ge 10 ]; then
            log_warn "进程未响应，强制终止..."
            kill -9 "$pid" 2>/dev/null || true
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
        local pid=$(cat "$PID_FILE")
        log_info "Metaclaw 正在运行 (PID: $pid)"

        # 显示进程信息
        ps -p "$pid" -o pid,ppid,%cpu,%mem,etime,command | tail -n +2

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

# 主逻辑
case "${1:-}" in
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
    logs)
        logs "${2:-}"
        ;;
    *)
        echo "用法: $0 {start|stop|restart|status|logs [-f]}"
        echo ""
        echo "命令:"
        echo "  start    - 启动 Metaclaw"
        echo "  stop     - 停止 Metaclaw"
        echo "  restart  - 重启 Metaclaw"
        echo "  status   - 查看运行状态"
        echo "  logs     - 查看日志 (加 -f 实时跟踪)"
        exit 1
        ;;
esac
