#!/bin/bash
# Double-clickable launcher for FileDrop (macOS).
cd "$(dirname "$0")" || exit 1

PORT="${FILEDROP_PORT:-8090}"

# Terminal runs .command files with a minimal PATH; add the usual Node homes.
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
[ -s "$HOME/.nvm/nvm.sh" ] && . "$HOME/.nvm/nvm.sh" >/dev/null 2>&1

pause_and_exit() {
  echo
  read -r -p "Press Enter to close this window..."
  exit "$1"
}

if ! command -v npm >/dev/null 2>&1; then
  echo "FileDrop needs Node.js, but npm was not found."
  echo "Install it from https://nodejs.org (or: brew install node) and try again."
  pause_and_exit 1
fi

if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "FileDrop is already running — opening the admin page."
  open "http://localhost:$PORT/admin"
  pause_and_exit 0
fi

if [ ! -d node_modules ]; then
  echo "First run — installing dependencies..."
  npm install || pause_and_exit 1
fi

# Open the admin page once the server has had a moment to start.
( sleep 1.5 && open "http://localhost:$PORT/admin" ) &

npm start
STATUS=$?
# 0 = clean exit; >=128 = stopped by a signal (Ctrl+C, window closed) — both normal.
if [ "$STATUS" -ne 0 ] && [ "$STATUS" -lt 128 ]; then
  echo
  echo "FileDrop stopped unexpectedly (exit code $STATUS) — see the error above."
  pause_and_exit "$STATUS"
fi
