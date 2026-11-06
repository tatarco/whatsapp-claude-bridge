#!/usr/bin/env bash
# Prepare one WhatsApp number: data dir + background service (systemd or launchd).
# Usage: ./add-number.sh <name> <port>      e.g. ./add-number.sh personal 8788
# Writes the service but does not start it: pair first (see INSTALL.md).
set -euo pipefail
name=${1:?usage: add-number.sh <name> <port>}
port=${2:?usage: add-number.sh <name> <port>}
[[ $name =~ ^[a-z0-9-]+$ ]] || { echo "name must be lowercase letters, digits, dashes" >&2; exit 1; }
[[ $port =~ ^[0-9]+$ ]] || { echo "port must be a number" >&2; exit 1; }

repo=$(cd "$(dirname "$0")" && pwd)
dir=$HOME/agents/wa-$name
node=$(command -v node)
[ -d "$repo/node_modules/baileys" ] || (cd "$repo" && npm ci)
mkdir -p "$dir"
chmod 700 "$dir"

if [ "$(uname)" = Darwin ]; then
  unit=$HOME/Library/LaunchAgents/com.wa.bridge.$name.plist
  mkdir -p "$(dirname "$unit")"
  cat > "$unit" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.wa.bridge.$name</string>
  <key>ProgramArguments</key><array><string>$node</string><string>$repo/wa.js</string></array>
  <key>EnvironmentVariables</key><dict>
    <key>WA_DIR</key><string>$dir</string>
    <key>WA_PORT</key><string>$port</string>
  </dict>
  <key>WorkingDirectory</key><string>$dir</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$dir/bridge.log</string>
  <key>StandardErrorPath</key><string>$dir/bridge.log</string>
</dict></plist>
PLIST
  start="launchctl bootstrap gui/$(id -u) '$unit'"
else
  unit=$HOME/.config/systemd/user/wa-$name.service
  mkdir -p "$(dirname "$unit")"
  cat > "$unit" <<UNIT
[Unit]
Description=WhatsApp bridge ($name, port $port)
After=network-online.target

[Service]
Environment=WA_DIR=$dir WA_PORT=$port
WorkingDirectory=$dir
ExecStart=$node $repo/wa.js
Restart=always
RestartSec=10
StandardOutput=append:$dir/bridge.log
StandardError=append:$dir/bridge.log

[Install]
WantedBy=default.target
UNIT
  start="systemctl --user daemon-reload && systemctl --user enable --now wa-$name"
fi

cat <<DONE
Ready: $name on port $port, data in $dir
Pair:  WA_DIR='$dir' WA_PORT=$port WA_PAIR_PHONE=<digits, with country code> node '$repo/wa.js'
Start: $start
DONE
