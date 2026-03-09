---
name: gen-changelog
description: Generate changelog entries for code changes.
---

根据当前分支相对于 main 分支的修改，生成更新日志条目并同步到文档站点。

## 步骤

1. **分析变更**：查看 `git log main..HEAD --oneline` 和 `git diff main..HEAD --stat`，理解所有变更。
2. **更新源 CHANGELOG**：在根目录 `CHANGELOG.md` 的 `## Unreleased` 下添加条目；如果变更属于 `packages/` 或 `sdks/` 下的子包，同时更新对应目录的 `CHANGELOG.md`。
3. **同步英文文档 changelog**：运行 `node docs/scripts/sync-changelog.mjs` 将根 `CHANGELOG.md` 同步到 `docs/en/release-notes/changelog.md`。
4. **更新中文文档 changelog**：在 `docs/zh/release-notes/changelog.md` 的 `## 未发布` 下添加对应的中文翻译条目，遵循现有格式和用词规范（参考 `docs/AGENTS.md` 中的术语表和排版规范）。
5. **Breaking changes**（如有）：如果变更包含破坏性变更（如移除/重命名选项、更改默认行为、迁移配置格式等），还需在 `docs/en/release-notes/breaking-changes.md` 和 `docs/zh/release-notes/breaking-changes.md` 的 `## Unreleased` / `## 未发布` 下添加对应条目，遵循现有的格式（版本标题 + 小节 + 受影响/迁移说明）。

## 注意事项

- 条目风格遵循现有 CHANGELOG 的格式：`- 分类: 描述`（如 `- Core: ...`、`- Web: ...`）。
- 只写对用户有意义的变更，不写纯内部重构。
- 中文翻译应遵循 `docs/AGENTS.md` 中的术语映射和排版规范。
