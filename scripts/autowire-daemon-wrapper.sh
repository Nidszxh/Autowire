#!/bin/bash
# Flatpak daemon wrapper with auto-restart on crash (systemd handles this
# for the native install; Flatpak has no systemd inside the sandbox).
while true; do
    gjs -I /app/share/autowire /app/share/autowire/daemon_main.js "$@"
    rc=$?
    if [ $rc -eq 0 ]; then
        exit 0
    fi
    echo "[autowire-daemon] Daemon exited with code $rc, restarting in 2s..."
    sleep 2
done