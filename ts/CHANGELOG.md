# Changelog

All notable changes to this project are recorded here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
version numbers follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `/undo` rolls back the previous turn via `session.rollback` and re-opens
  the session from the truncated wire log.
- `/changelog` surfaces the latest entry from this file inside the
  interactive session.
- `/hooks` prints the hooks advertised by
  `initialize.capabilities.hooks.configured[]`.
- Dynamic skill dispatch: an unmatched `/name` tries `session.listSkills`
  and activates the skill when one with a matching name exists. Built-in
  commands always take precedence.
