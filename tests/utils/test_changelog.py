from __future__ import annotations

from kimi_cli.utils.changelog import ReleaseEntry, parse_changelog


def test_changelog_parser():
    changelog = """
# Changelog

<!--
Release notes will be parsed and available as /release-notes
The parser extracts for each version:
  - a short description (first paragraph after the version header)
  - bullet entries beginning with "- " under that version (across any subsections)
Internal builds may append content to the Unreleased section.
Only write entries that are worth mentioning to users.
-->

## Unreleased

### Added
- Added /release-notes command

### Fixed
- Fixed a bug

## 0.10.1 (2025-09-18)

We now have release notes!
- Made slash commands look slightly better
    """
    assert {
        "Unreleased": ReleaseEntry(
            description="", entries=["Added /release-notes command", "Fixed a bug"]
        ),
        "0.10.1": ReleaseEntry(
            description="We now have release notes!",
            entries=["Made slash commands look slightly better"],
        ),
    } == parse_changelog(changelog)
