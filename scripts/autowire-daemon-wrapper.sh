#!/bin/bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Flatpak daemon wrapper with auto-restart on crash (systemd handles this
# for the native install; Flatpak has no systemd inside the sandbox).
while true; do
    gjs -I /app/share/autowire /app/share/autowire/daemon_main.js "$@"
    rc=$?
    # Exit code 0 = intentional shutdown (SIGTERM/SIGINT handled by daemon).
    # Exit code >= 128 = terminated by signal (SIGTERM=143, SIGINT=130) -
    #   treat as intentional since GLibUnix.signal_add may not catch all cases.
    if [ $rc -eq 0 ] || [ $rc -ge 128 ]; then
        exit 0
    fi
    echo "[autowire-daemon] Daemon exited with code $rc, restarting in 2s..."
    sleep 2
done