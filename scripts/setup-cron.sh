#!/bin/bash
# Sets up a macOS launchd agent to run the ingestion pipeline every 6 hours.
# Usage: bash scripts/setup-cron.sh [APP_URL]
# Example: bash scripts/setup-cron.sh http://localhost:3000

APP_URL="${1:-http://localhost:3000}"
LABEL="io.itmarketintel.ingest"
PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"
CRON_SECRET="${CRON_SECRET:-}"

echo "Setting up launchd cron for IT Market Intel ingestion pipeline..."
echo "  App URL:  $APP_URL"
echo "  Interval: every 6 hours"

# Build auth header line
AUTH_HEADER=""
if [ -n "$CRON_SECRET" ]; then
  AUTH_HEADER="<string>-H</string><string>Authorization: Bearer $CRON_SECRET</string>"
fi

cat > "$PLIST" << PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/curl</string>
    <string>-s</string>
    <string>-o</string>
    <string>/tmp/it-market-ingest.log</string>
    ${AUTH_HEADER}
    <string>${APP_URL}/api/cron</string>
  </array>
  <key>StartInterval</key>
  <integer>21600</integer>
  <!-- 21600 seconds = 6 hours -->
  <key>RunAtLoad</key>
  <false/>
  <key>StandardErrorPath</key>
  <string>/tmp/it-market-ingest-error.log</string>
</dict>
</plist>
PLIST_EOF

# Load the agent (unload first if already loaded)
launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"

echo ""
echo "✓ Cron agent installed and loaded: $LABEL"
echo "  Pipeline will run every 6 hours automatically."
echo "  Logs: /tmp/it-market-ingest.log"
echo ""
echo "Other commands:"
echo "  Run now:    launchctl start $LABEL"
echo "  Stop:       launchctl unload $PLIST"
echo "  Remove:     launchctl unload $PLIST && rm $PLIST"
