# Changelog

## Unreleased

## 0.6.0 (2026-01-09)

- Add optional `n` parameter to `readbytes` to read only the first n bytes

## 0.5.4 (2026-01-06)

- Relax `aiofiles` dependency version to `>=24.0,<26.0`

## 0.5.3 (2025-12-29)

- Add `host` property to `SSHKaos`

## 0.5.2 (2025-12-17)

- Fix `SSHKaos.Process.wait` to not drain stdout/stderr buffers
- Return 1 as return code if `SSHKaos.Process.wait` does not get a return code

## 0.5.1 (2025-12-15)

- Fix unhandled exception thrown by `SSHKaos.stat` when the file does not exist
- Fix `SSHKaos.exec` without CWD
- Fix `SSHKaos.iterdir` to return `KaosPath`

## 0.5.0 (2025-12-12)

- Move `KaosProcess` to `Kaos.Process`
- Add `AsyncReadable` and `AsyncWritable` protocols
- Add `SSHKaos` implementation
- Lower the required Python version to 3.12

## 0.4.0 (2025-12-06)

- Add `Kaos.exec` method for executing commands
- Add `StepResult` as the return type for `Kaos.stat`

## 0.3.0 (2025-12-03)

- Change `iterdir`, `glob` and `read_lines` to sync function returning `AsyncIterator`

## 0.2.0 (2025-12-01)

- Initial release with `Kaos` protocol, `LocalKaos` implementation, and `KaosPath` for convenient file operations
