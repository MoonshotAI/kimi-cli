# Sound Assets

Place sound files here to enable audio notifications in the interactive shell UI.

| File name | Purpose | Recommended format |
|-----------|---------|-------------------|
| `done_sound.wav` | Played when the agent finishes a turn/task | `.wav` (cross-platform) |
| `permission_sound.wav` | Played when the agent needs user approval/permission | `.wav` (cross-platform) |

Any format supported by your platform's audio player will work (e.g., `.mp3`, `.ogg`, `.aac`, `.flac`), but `.wav` has the best out-of-the-box support across macOS (`afplay`), Linux (`aplay`/`paplay`), and Windows (`powershell.exe`).

If a sound file is missing, the app falls back silently (no error, no sound).
