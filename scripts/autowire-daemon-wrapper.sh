#!/bin/bash
# Flatpak daemon wrapper with auto-restart on crash (systemd handles this
# for the native install; Flatpak has no systemd inside the sandbox).
while true; do
    gjs -I /app/share/autowire /app/share/autowire/daemon_main.js "$@"
    echo "[autowire-daemon] Daemon exited unexpectedly, restarting in 2s..."
    sleep 2
done