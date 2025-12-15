# Changelog

## [0.5.1] - 2025-12-15

- Fix unhandled exception thrown by `SSHKaos.stat` when the file does not exist.
- Fix `SSHKaos.exec` without CWD.
- Fix `SSHKaos.iterdir` to return `KaosPath`.

## [0.5.0] - 2025-12-12

- Move `KaosProcess` to `Kaos.Process`.
- Add `AsyncReadable` and `AsyncWritable` protocols.
- Add `SSHKaos` implementation.
- Lower the required Python version to 3.12

## [0.4.0] - 2025-12-06

- Add `Kaos.exec` method for executing commands.
- Add `StepResult` as the return type for `Kaos.stat`.

## [0.3.0] - 2025-12-03

- Change `iterdir`, `glob` and `read_lines` to sync function returning `AsyncIterator`.

## [0.2.0] - 2025-12-01

- Initial release with `Kaos` protocol, `LocalKaos` implementation, and `KaosPath` for convenient file operations.
