#!/bin/bash
# TTS Notification Hook for Kimi CLI
# Plays a voice notification when the session ends

# Configuration (can be overridden via environment variables)
: "${TTS_VOICE:=Ting-Ting}"        # macOS voice (use 'say -v "?"' to list all)
: "${TTS_RATE:=180}"               # Speech rate (words per minute, macOS only)
: "${TTS_ENABLED:=true}"           # Set to 'false' to disable

# Read event data from stdin
event_data=$(cat)

# Check if TTS is enabled
if [[ "$TTS_ENABLED" != "true" ]]; then
    echo "TTS notification disabled via TTS_ENABLED" >&2
    exit 0
fi

# Extract session info
duration=$(echo "$event_data" | sed -n 's/.*"duration_seconds":[[:space:]]*\([0-9]*\).*/\1/p')
exit_reason=$(echo "$event_data" | sed -n 's/.*"exit_reason":[[:space:]]*"\([^"]*\)".*/\1/p')
total_steps=$(echo "$event_data" | sed -n 's/.*"total_steps":[[:space:]]*\([0-9]*\).*/\1/p')

# Determine message based on exit reason and duration
case "$exit_reason" in
    "user_exit")
        message="会话已完成。再见！"
        ;;
    "error")
        message="会话以错误结束。请检查日志。"
        ;;
    "timeout")
        message="会话超时。"
        ;;
    *)
        message="会话结束。"
        ;;
esac

# Add duration info if available
if [[ -n "$duration" && "$duration" -gt 0 ]]; then
    if [[ "$duration" -lt 60 ]]; then
        message="${message} 持续时间：${duration}秒。"
    else
        minutes=$((duration / 60))
        seconds=$((duration % 60))
        if [[ "$seconds" -eq 0 ]]; then
            message="${message} 持续时间：${minutes}分钟。"
        else
            message="${message} 持续时间：${minutes}分${seconds}秒。"
        fi
    fi
fi

# Add steps info if available
if [[ -n "$total_steps" && "$total_steps" -gt 0 ]]; then
    message="${message} 总步数：${total_steps}。"
fi

# Play TTS based on OS
play_tts() {
    local msg="$1"
    
    if [[ "$OSTYPE" == "darwin"* ]]; then
        # macOS - use say command
        # Available voices: say -v '?' | grep zh (for Chinese voices)
        # Chinese voices: Ting-Ting, Sin-ji, Mei-Jia
        # English voices: Samantha, Alex, Victoria, Fred, Vicki, Bruce
        
        # Check if voice is available
        if say -v "?" 2>/dev/null | grep -q "^${TTS_VOICE} "; then
            say -v "$TTS_VOICE" -r "$TTS_RATE" "$msg" 2>/dev/null
        else
            # Fallback to default voice
            say "$msg" 2>/dev/null
        fi
        return 0
        
    elif [[ "$OSTYPE" == "linux-gnu"* ]]; then
        # Linux - try espeak or spd-say
        if command -v spd-say &> /dev/null; then
            spd-say "$msg" 2>/dev/null
            return 0
        elif command -v espeak &> /dev/null; then
            espeak "$msg" 2>/dev/null
            return 0
        else
            echo "TTS not available. Install espeak or speech-dispatcher." >&2
            return 1
        fi
        
    elif [[ "$OSTYPE" == "msys" || "$OSTYPE" == "cygwin" || "$OSTYPE" == "win32" ]]; then
        # Windows - use PowerShell TTS
        powershell -Command "Add-Type -AssemblyName System.Speech; \$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer; \$synth.Speak('$msg');" 2>/dev/null
        return 0
    fi
    
    return 1
}

# Play the TTS message
if play_tts "$message"; then
    echo "TTS notification played: $message" >&2
else
    echo "Failed to play TTS notification" >&2
fi

exit 0
