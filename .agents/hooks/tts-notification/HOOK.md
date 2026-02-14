---
name: tts-notification
description: Play text-to-speech notification when session ends
trigger: post-session
async: true
timeout: 10000
priority: 10
---

# TTS Notification Hook

Play a text-to-speech notification when Kimi CLI session ends.

## Behavior

This hook runs asynchronously at session end:

1. Reads session info from stdin
2. Plays a TTS message using macOS `say` command
3. Does not block session termination

## Requirements

- macOS (uses `say` command)
- For Linux: requires `espeak` or `spd-say`
- For Windows: requires PowerShell with SAPI

## Script

Entry point: `scripts/run.sh`
