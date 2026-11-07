#!/bin/bash
# Starts the Family Feud server, keeps the Mac awake, and opens the TV board.
cd "$(dirname "$0")"
if lsof -i :3000 -sTCP:LISTEN >/dev/null 2>&1; then
  echo "Family Feud is already running. Opening the board…"
  open "http://localhost:3000/board"
  exit 0
fi
(sleep 1.5; open "http://localhost:3000/board") &
exec caffeinate -dis node server.js
