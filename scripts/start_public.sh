#!/usr/bin/env bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# Ensure clean state
"$SCRIPT_DIR/stop_public.sh" >/dev/null 2>&1 || true

echo "=================================================="
echo " Starting SocratiQ Application with Public Tunnel"
echo "=================================================="

# Check virtual environment
if [ ! -f "$ROOT_DIR/.venv/bin/uvicorn" ]; then
    echo "Error: Python virtual environment not found at $ROOT_DIR/.venv"
    exit 1
fi

# Check cloudflared binary
if [ ! -x "$SCRIPT_DIR/bin/cloudflared" ]; then
    echo "Downloading cloudflared binary..."
    mkdir -p "$SCRIPT_DIR/bin"
    curl -sL https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -o "$SCRIPT_DIR/bin/cloudflared"
    chmod +x "$SCRIPT_DIR/bin/cloudflared"
fi

# 1. Start Backend
echo "1. Starting Backend API (Port 8000)..."
cd "$ROOT_DIR"
nohup "$ROOT_DIR/.venv/bin/uvicorn" backend.app.main:app --host 127.0.0.1 --port 8000 > "$SCRIPT_DIR/backend.log" 2>&1 &
BACKEND_PID=$!
echo "$BACKEND_PID" > "$SCRIPT_DIR/backend.pid"

# Wait for backend health
MAX_WAIT=20
WAIT_COUNT=0
until curl -s http://127.0.0.1:8000/health | grep -q '"status":"ok"'; do
    if [ $WAIT_COUNT -ge $MAX_WAIT ]; then
        echo "Error: Backend failed to start. Logs:"
        cat "$SCRIPT_DIR/backend.log"
        exit 1
    fi
    sleep 1
    WAIT_COUNT=$((WAIT_COUNT + 1))
done
echo "   ✓ Backend healthy (PID: $BACKEND_PID)"

# 2. Start Frontend
echo "2. Starting Frontend Dev Server with Reverse Proxy (Port 5173)..."
nohup npm --prefix "$ROOT_DIR/frontend" run dev > "$SCRIPT_DIR/frontend.log" 2>&1 &
FRONTEND_PID=$!
echo "$FRONTEND_PID" > "$SCRIPT_DIR/frontend.pid"

# Wait for frontend
WAIT_COUNT=0
until curl -sI http://127.0.0.1:5173/ | grep -q "200 OK"; do
    if [ $WAIT_COUNT -ge $MAX_WAIT ]; then
        echo "Error: Frontend failed to start. Logs:"
        cat "$SCRIPT_DIR/frontend.log"
        exit 1
    fi
    sleep 1
    WAIT_COUNT=$((WAIT_COUNT + 1))
done
echo "   ✓ Frontend ready (PID: $FRONTEND_PID)"

# 3. Start Cloudflare Tunnel
echo "3. Starting Cloudflare Quick Tunnel to Frontend..."
rm -f "$SCRIPT_DIR/tunnel.log"
nohup "$SCRIPT_DIR/bin/cloudflared" tunnel --url http://127.0.0.1:5173 > "$SCRIPT_DIR/tunnel.log" 2>&1 &
TUNNEL_PID=$!
echo "$TUNNEL_PID" > "$SCRIPT_DIR/tunnel.pid"

# Wait for tunnel URL
echo "   Waiting for public HTTPS URL from Cloudflare Edge..."
WAIT_COUNT=0
TUNNEL_URL=""
while [ -z "$TUNNEL_URL" ]; do
    if [ $WAIT_COUNT -ge 30 ]; then
        echo "Error: Timed out waiting for Cloudflare tunnel URL. Logs:"
        cat "$SCRIPT_DIR/tunnel.log"
        exit 1
    fi
    sleep 1
    WAIT_COUNT=$((WAIT_COUNT + 1))
    if [ -f "$SCRIPT_DIR/tunnel.log" ]; then
        TUNNEL_URL=$(grep -o 'https://[-a-zA-Z0-9\.]*\.trycloudflare\.com' "$SCRIPT_DIR/tunnel.log" | head -n 1 || true)
    fi
done

echo "   ✓ Tunnel established (PID: $TUNNEL_PID)"

# 4. Verify Public Reachability
echo "4. Verifying public reachability through Cloudflare (waiting for edge propagation)..."
DOMAIN="${TUNNEL_URL#https://}"
RESOLVE_ARG=""
EDGE_IP=$(dig +short @8.8.8.8 "$DOMAIN" 2>/dev/null | grep -E '^[0-9.]+$' | head -n 1 || true)
if [ -n "$EDGE_IP" ]; then
    RESOLVE_ARG="--resolve $DOMAIN:443:$EDGE_IP"
fi

PUBLIC_CODE="000"
WAIT_COUNT=0
while [ "$PUBLIC_CODE" != "200" ] && [ $WAIT_COUNT -lt 15 ]; do
    PUBLIC_CODE=$(curl -s -k $RESOLVE_ARG -o /dev/null -w "%{http_code}" "$TUNNEL_URL/" || true)
    if [ "$PUBLIC_CODE" != "200" ]; then
        sleep 2
        WAIT_COUNT=$((WAIT_COUNT + 1))
    fi
done
API_CODE=$(curl -s -k $RESOLVE_ARG -o /dev/null -w "%{http_code}" "$TUNNEL_URL/health" || true)

echo ""
echo "======================================================================"
echo " 🎉 SocratiQ is LIVE on the Public Internet!"
echo "======================================================================"
echo " Public Shareable URL: $TUNNEL_URL"
echo " Backend Health Check: $TUNNEL_URL/health (HTTP $API_CODE)"
echo " Frontend Index Page : $TUNNEL_URL/ (HTTP $PUBLIC_CODE)"
echo " WebSocket Endpoint  : ${TUNNEL_URL/https:/wss:}/api/v1/smartboard/live"
echo "----------------------------------------------------------------------"
echo " Architecture        : Single HTTPS Origin (Reverse Proxy enabled)"
echo " Stop Command        : $SCRIPT_DIR/stop_public.sh"
echo " Logs Directory      : $SCRIPT_DIR/{backend,frontend,tunnel}.log"
echo "======================================================================"

# If running as daemon/background script, finish; otherwise, keep alive
if [ "$1" = "--daemon" ] || [ "$1" = "-d" ]; then
    echo "Services running in background."
    exit 0
fi

trap "$SCRIPT_DIR/stop_public.sh; exit 0" INT TERM

echo "Keeping tunnel active. Press Ctrl+C to stop all services..."
while kill -0 "$TUNNEL_PID" 2>/dev/null && kill -0 "$FRONTEND_PID" 2>/dev/null && kill -0 "$BACKEND_PID" 2>/dev/null; do
    sleep 2
done
