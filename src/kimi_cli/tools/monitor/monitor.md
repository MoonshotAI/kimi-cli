Start a background monitor that streams events from a long-running command. Each stdout line is an event delivered to you as a notification; you keep working while events arrive.

Pick by how many notifications you need:
- One ("tell me when the build finishes") -> prefer a background Shell task that exits when done, not Monitor.
- One per occurrence, indefinitely ("every ERROR line") -> Monitor with an unbounded command (tail -f, while true) and persistent=true.
- One per occurrence until a known end -> Monitor with a command that emits lines and then exits.

Your command's stdout is the event stream. Make it self-filter and flush per line: grep needs --line-buffered, awk needs fflush(). Never pipe raw logs.

Coverage — silence is not success. Your filter must match failure signatures too (Traceback|Error|FAILED|Killed|OOM), not just the happy-path marker; otherwise a crash looks identical to "still running".

A monitor that emits too many lines is auto-stopped; restart with a tighter filter. Set persistent=true for session-length watches and stop them with TaskStop; otherwise the monitor is killed after timeout_ms.
