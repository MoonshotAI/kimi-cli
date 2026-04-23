#!/bin/bash
set -euo pipefail

REPO="/devops/kimi-cli-dev"
LOG="$REPO/.watch_merge.log"
INTERVAL=300  # 5 minutes

echo "[$(date -Iseconds)] Starting merge watcher..." > "$LOG"

cd "$REPO"

while true; do
    git fetch upstream main --quiet
    LOCAL=$(git rev-parse HEAD)
    UPSTREAM=$(git rev-parse upstream/main)
    BASE=$(git merge-base HEAD upstream/main)
    
    if [ "$UPSTREAM" != "$BASE" ]; then
        echo "[$(date -Iseconds)] upstream/main has new commits. Need rebase." >> "$LOG"
        git log --oneline "$BASE..$UPSTREAM" >> "$LOG"
        
        # Attempt rebase
        if git rebase upstream/main; then
            echo "[$(date -Iseconds)] Rebase successful." >> "$LOG"
            # Run quick checks
            if make check >> "$LOG" 2>&1; then
                echo "[$(date -Iseconds)] Checks passed." >> "$LOG"
            else
                echo "[$(date -Iseconds)] CHECKS FAILED!" >> "$LOG"
            fi
            # Push rebased branch
            git push origin main --force-with-lease >> "$LOG" 2>&1 || true
        else
            echo "[$(date -Iseconds)] REBASE FAILED! Manual intervention required." >> "$LOG"
            git rebase --abort || true
        fi
    else
        echo "[$(date -Iseconds)] upstream/main unchanged. Branch is clean." >> "$LOG"
    fi
    
    sleep $INTERVAL
done
