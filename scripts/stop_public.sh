#!/usr/bin/env bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

echo "=== Stopping SocratiQ Public Services ==="

# 1. Stop Tunnel
if [ -f "$SCRIPT_DIR/tunnel.pid" ]; then
    TPID=$(cat "$SCRIPT_DIR/tunnel.pid")
    if kill -0 "$TPID" 2>/dev/null; then
        echo "Stopping tunnel (PID: $TPID)..."
        kill "$TPID" 2>/dev/null || true
    fi
    rm -f "$SCRIPT_DIR/tunnel.pid"
fi
pkill -f "cloudflared tunnel" 2>/dev/null || true

# 2. Stop Frontend
if [ -f "$SCRIPT_DIR/frontend.pid" ]; then
    FPID=$(cat "$SCRIPT_DIR/frontend.pid")
    if kill -0 "$FPID" 2>/dev/null; then
        echo "Stopping frontend (PID: $FPID)..."
        kill "$FPID" 2>/dev/null || true
    fi
    rm -f "$SCRIPT_DIR/frontend.pid"
fi
fuser -k 5173/tcp 2>/dev/null || true

# 3. Stop Backend
if [ -f "$SCRIPT_DIR/backend.pid" ]; then
    BPID=$(cat "$SCRIPT_DIR/backend.pid")
    if kill -0 "$BPID" 2>/dev/null; then
        echo "Stopping backend (PID: $BPID)..."
        kill "$BPID" 2>/dev/null || true
    fi
    rm -f "$SCRIPT_DIR/backend.pid"
fi
fuser -k 8000/tcp 2>/dev/null || true

echo "✓ All SocratiQ services and tunnels have been stopped cleanly."
