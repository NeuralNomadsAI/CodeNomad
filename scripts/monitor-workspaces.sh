#!/usr/bin/env bash
# Monitor CodeNomad workspace activity in real time
# Usage: ./monitor-workspaces.sh

LOG_FILE="${HOME}/.pm2/logs/codenomad-fork-out.log"

echo "=========================================="
echo "  CodeNomad Workspace Monitor"
echo "=========================================="
echo ""
echo "Monitoring: $LOG_FILE"
echo "Press Ctrl+C to stop"
echo ""
echo "Watching for:"
echo "  - Workspace create requests"
echo "  - Deduplication hits (reuse)"
echo "  - New workspace creations"
echo "  - Dedup misses (potential bugs)"
echo ""
echo "------------------------------------------"
echo ""

tail -F "$LOG_FILE" 2>/dev/null | grep --line-buffered -E \
  "Workspace create requested|Reusing existing workspace|Creating new workspace|dedup_missed|action=" | \
  while IFS= read -r line; do
    # Color code based on action
    if echo "$line" | grep -q "dedup_missed"; then
      echo -e "\033[1;31m$line\033[0m"  # Red - bug detected
    elif echo "$line" | grep -q "reused"; then
      echo -e "\033[1;33m$line\033[0m"  # Yellow - dedup hit
    elif echo "$line" | grep -q "created"; then
      echo -e "\033[1;32m$line\033[0m"  # Green - new workspace
    elif echo "$line" | grep -q "create_request"; then
      echo -e "\033[1;36m$line\033[0m"  # Cyan - request
    else
      echo "$line"
    fi
  done