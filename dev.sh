#!/bin/bash

###############################################################################
# FreeSWITCH Development Control Script
#
# Supports:
#   FS-CC
#   FS-ENRS
#
# Features
# --------
# ✓ PM2 backend management
# ✓ Vite frontend management
# ✓ Health checks
# ✓ Auto cleanup
# ✓ Port verification
# ✓ Backend verification
# ✓ Socket verification
# ✓ Colored output
###############################################################################

FS_CC="/opt/freeswitch-ui/fs-cc"
FS_ENRS="/opt/freeswitch-ui/fs-enrs"

GREEN="\033[0;32m"
RED="\033[0;31m"
YELLOW="\033[1;33m"
BLUE="\033[0;34m"
NC="\033[0m"

###############################################################################
print_ok() {
    echo -e "${GREEN}✔ $1${NC}"
}

print_error() {
    echo -e "${RED}✖ $1${NC}"
}

print_warn() {
    echo -e "${YELLOW}⚠ $1${NC}"
}

print_info() {
    echo -e "${BLUE}$1${NC}"
}

###############################################################################
kill_vite() {

    pkill -f vite 2>/dev/null
    pkill -f esbuild 2>/dev/null
    pkill -f "npm run dev" 2>/dev/null

}

###############################################################################
kill_port() {

    PORT=$1

    PID=$(lsof -ti:$PORT)

    if [ ! -z "$PID" ]; then
        kill -9 $PID
    fi

}

###############################################################################
wait_port() {

    PORT=$1

    for i in {1..20}
    do

        ss -ltn | grep ":$PORT " >/dev/null

        if [ $? -eq 0 ]; then
            return 0
        fi

        sleep 1

    done

    return 1
}

###############################################################################
start_enrs() {

    print_info "Starting FS-ENRS..."

    mkdir -p "$FS_ENRS/backend/logs"

    kill_port 4100
    kill_port 8100

    pm2 delete fs-enrs-backend >/dev/null 2>&1

    cd "$FS_ENRS/backend"

    pm2 start ecosystem.config.cjs

    sleep 3

    pm2 describe fs-enrs-backend | grep errored >/dev/null

    if [ $? -eq 0 ]; then

        print_error "Backend crashed."

        echo
        pm2 logs fs-enrs-backend --lines 40

        return

    fi

    if wait_port 4100; then

        print_ok "Backend running on :4100"

    else

        print_error "Backend failed to open port 4100"

        pm2 logs fs-enrs-backend --lines 40

        return

    fi

    cd "$FS_ENRS/frontend"

    nohup npm run dev -- --host 0.0.0.0 --port 8100 >/tmp/fs-enrs-frontend.log 2>&1 &

    if wait_port 8100; then

        print_ok "Frontend running on :8100"

    else

        print_error "Frontend failed."

        return

    fi

    echo
    print_ok "FS-ENRS Started Successfully"
    echo
    echo "Frontend : http://$(hostname -I | awk '{print $1}'):8100"
    echo "Backend  : http://$(hostname -I | awk '{print $1}'):4100/api/health"

}

###############################################################################
stop_enrs() {

    print_info "Stopping FS-ENRS..."

    pm2 delete fs-enrs-backend >/dev/null 2>&1

    kill_port 4100
    kill_port 8100

    kill_vite

    print_ok "Stopped."

}

###############################################################################
restart_enrs() {

    stop_enrs

    sleep 2

    start_enrs

}

###############################################################################
status_enrs() {

    echo

    pm2 status fs-enrs-backend

    echo

    if ss -ltn | grep ":4100 " >/dev/null
    then
        print_ok "Backend Port 4100 UP"
    else
        print_error "Backend Port DOWN"
    fi

    if ss -ltn | grep ":8100 " >/dev/null
    then
        print_ok "Frontend Port 8100 UP"
    else
        print_error "Frontend Port DOWN"
    fi

    echo

    curl -s http://localhost:4100/api/health

    echo
    echo

}

###############################################################################
logs_enrs() {

    pm2 logs fs-enrs-backend

}

###############################################################################
doctor_enrs() {

    echo
    print_info "Running Diagnostics..."
    echo

    echo "PM2"

    pm2 status fs-enrs-backend

    echo

    echo "Backend Port"

    ss -ltn | grep 4100

    echo

    echo "Frontend Port"

    ss -ltn | grep 8100

    echo

    echo "Database"

    PGPASSWORD=$(grep DB_PASSWORD "$FS_ENRS/backend/.env" | cut -d= -f2) \
    psql -h localhost \
    -U fs_enrs \
    -d fs_enrs \
    -c "select now();" >/dev/null

    if [ $? -eq 0 ]; then

        print_ok "Database OK"

    else

        print_error "Database FAILED"

    fi

    echo

    echo "Backend Health"

    curl http://localhost:4100/api/health

    echo
    echo

}

###############################################################################
case "$1" in

start)

start_enrs
;;

stop)

stop_enrs
;;

restart)

restart_enrs
;;

status)

status_enrs
;;

logs)

logs_enrs
;;

doctor)

doctor_enrs
;;

*)

echo

echo "Usage"

echo

echo "./dev.sh start"

echo "./dev.sh stop"

echo "./dev.sh restart"

echo "./dev.sh status"

echo "./dev.sh logs"

echo "./dev.sh doctor"

echo

;;

esac
