---
name: release
description: Execute the release workflow for Kimi CLI packages. Use when user wants to release a new version, bump version numbers, create release PRs, or prepare packages for publishing.
---

# Release Workflow

1. 首先从 AGENTS.md 和 .github/workflows/release*.yml 中理解本项目的发版自动化流程。
2. 检查每个 packages、sdks 和根目录的包是否在上次发版（根据 tag 确认）后有变更。
3. 如果有变更，对于每个变更的包，跟我确认新的版本号（遵循语义化版本规范），并更新相应的：
   - pyproject.toml
   - CHANGELOG.md（要保留 Unreleased 标题）
   - 中英文档的 breaking-changes.md 文件中的版本号
4. 运行 `uv sync`。
5. 运行 gen-docs skill 中的指示以确保文档是最新的。
6. 开一个新的分支叫 `bump-<package>-<new-version>`，提交所有更改并推送到远程仓库。
   - 如果一次有多个包需要发版，可以合并在一个分支升级版本号，分支名适当编写即可。
7. 用 gh 命令开一个 Pull Request，描述所做的更改。
8. 持续检查这个 PR 的状态，直到被合并。
9. 合并后，切到 main 分支，拉取最新的更改。
10. 提示我最终发布 tag 所需的 git tag 命令，我会自行 tag + push tags。
