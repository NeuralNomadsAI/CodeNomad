#!/bin/bash
# Wake Lock Testing Script for CodeNomad on KDE Wayland

echo "==================================="
echo "CodeNomad Wake Lock Test (KDE)"
echo "==================================="

# Check if qdbus6 is available
if ! command -v qdbus6 &> /dev/null; then
    echo "Error: qdbus6 not found"
    exit 1
fi

# Function to check current inhibitors
check_inhibitors() {
    echo ""
    echo "=== Power Management Inhibitors ==="
    
    HAS_INHIBIT=$(qdbus6 org.freedesktop.PowerManagement /org/freedesktop/PowerManagement/Inhibit HasInhibit 2>/dev/null)
    
    if [ "$HAS_INHIBIT" = "true" ]; then
        echo "✓ Wake lock is ACTIVE"
    else
        echo "○ Wake lock is INACTIVE"
    fi
    echo ""
    
    if command -v systemd-inhibit &> /dev/null; then
        echo "--- Systemd Inhibitors ---"
        systemd-inhibit --list 2>/dev/null | head -20
    fi
}

# Function to monitor wake lock
monitor_wake_lock() {
    echo "Monitoring wake lock... (Ctrl+C to stop)"
    echo ""
    
    while true; do
        clear
        echo "=== Wake Lock Monitor ($(date +%H:%M:%S)) ==="
        
        HAS_INHIBIT=$(qdbus6 org.freedesktop.PowerManagement /org/freedesktop/PowerManagement/Inhibit HasInhibit 2>/dev/null)
        
        if [ "$HAS_INHIBIT" = "true" ]; then
            echo "◉ WAKE LOCK: ACTIVE"
        else
            echo "○ WAKE LOCK: INACTIVE"
        fi
        echo ""
        
        echo "--- CodeNomad Processes ---"
        ps aux | grep -E "[e]lectron|[c]odenomad" | head -3
        echo ""
        
        sleep 2
    done
}

case "${1:-help}" in
    check)
        check_inhibitors
        ;;
    monitor)
        monitor_wake_lock
        ;;
    *)
        echo "Usage: $0 [check|monitor]"
        echo ""
        echo "  check   - Check wake lock status once"
        echo "  monitor - Monitor wake lock in real-time"
        ;;
esac
