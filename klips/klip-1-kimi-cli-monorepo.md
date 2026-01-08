---
Author: @stdrc
Updated: 2025-12-29
Status: Implemented
---

# KLIP-1: Move Kosong and PyKAOS to Kimi CLI Monorepo

下面是一份「可执行的操作计划」，把我们前面确定的方案全部串起来，并加入你新补充的 tag 规则（`kosong-0.20.0`；`pykaos-0.2.0`；`kimi-cli` 仍是 `0.68`/`0.68.1` 这种纯数字）。

## 1. 确定目标目录与命名

先定死，后面所有脚本/CI 都依赖它。

1. monorepo（目标仓库）仍然叫 `kimi-cli`，且 `kimi-cli` 包仍放在仓库根目录（保持你现在的结构/习惯）。
2. `kosong` 放到 `packages/kosong`，`pykaos` 放到 `packages/kaos`（目录叫 `kaos`，但 Python 包/发行名是 `pykaos`）。
3. 三个包的 `project.name`（PyPI 包名）分别是：`kimi-cli`、`kosong`、`pykaos`。
4. tag 约定：
    - `kimi-cli`：`0.68` / `0.68.1`（纯数字开头）
    - `kosong`：`kosong-0.20.0`（无 v）
    - `pykaos`：`pykaos-0.2.0`（无 v）

## 2. 把 uv workspace 配好

开发时三包联动；发布时仍是三个独立包。

1. 在仓库根 `pyproject.toml`（`kimi-cli`）里开启 workspace：`tool.uv.workspace.members = ["packages/kosong", "packages/kaos"]`。
2. 在仓库根 `pyproject.toml`（`kimi-cli`）里加 `tool.uv.sources`，把依赖映射到 workspace member：
    - `kosong = { workspace = true }`
    - `pykaos = { workspace = true }`
3. `kimi-cli` 的对外依赖（`project.dependencies`）写「发布后要生效的版本范围」，例如依赖 `kosong`、`pykaos` 的范围约束（你们自己决定兼容策略，上界不要省略）。开发时 uv 会用 workspace 里的本地包覆盖同名依赖；发布时用户仍会从 PyPI 拉对应版本。

## 3. 把 kosong、kaos 迁入 monorepo

同时保留 commit 历史但不带 tags。

对每个源仓库（`kosong`、`kaos`）都按下面流程做（在 `kimi-cli` 仓库里操作）：

1. 添加 remote。
2. 禁用该 remote 的 tags 拉取：`git config remote.<name>.tagOpt --no-tags`。
3. fetch 只抓默认分支（main/master）且不抓 tags：`git fetch --no-tags <remote> <branch>`。
4. 用 `git subtree add` 把它导入到指定目录：
    - `kosong`：`--prefix=packages/kosong`
    - `kaos`：`--prefix=packages/kaos`

这样 commit 历史会进入 monorepo，但你不会把原仓库的 tags 带进来（因为你根本不抓 tags，也不推 tags）。

## 4. 迁移后对代码做「最小必要改动」

确保三包仍能独立构建与发布。

1. 确认 `packages/kosong/pyproject.toml` 的 `[project]` 配置仍完整（name/version/dependencies 等）。
2. 确认 `packages/kaos/pyproject.toml` 的 `[project].name` 是 `pykaos`（不是 `kaos`）。目录名可以是 `kaos`，不影响发行名。
3. 如果 `kimi-cli` 里原来是通过相对路径/本地 editable 依赖来引用 `kosong`/`kaos`，把它们改为正常依赖（`kosong`、`pykaos`），并靠 `tool.uv.sources` 在本地走 workspace。
4. 在 monorepo 根做一次全量自检：
    - `uv sync`（或你们现在用的等价命令）
    - `uv run -m pytest` / `uv run kimi-cli` 的基本命令（按你们项目实际）

目标是：workspace 内能同时开发运行。

## 5. 把 CI/Release workflow 拆成三个

让 tag 触发互斥，且只有 `kimi-cli` 创建 GitHub Release。

核心原则：只有「纯数字 tag」触发 `kimi-cli` release；只有 `kosong-` 触发 `kosong` 发布；只有 `pykaos-` 触发 `pykaos` 发布。这样用户在 `kimi-cli` 仓库的 GitHub Releases 页只会看到 `kimi-cli` 的 release。

### 5.1 kimi-cli release workflow

保留你现有行为：tag 触发 -> build -> publish -> create GitHub Release。

- **触发**：`on push tags` 仅匹配数字开头（例如 `[0-9]*`）。
- **版本校验**：tag 本身就是版本号，必须等于根 `pyproject.toml` 的 `[project].version`，不一致直接 fail。
- **构建**：`uv build --package kimi-cli`，并且建议发布路径上用 `--no-sources` 做一次「发布语义」构建，避免 workspace sources 掩盖问题。
- **发布**：继续用你当前的 PyPI publish 方式。
- **Release**：继续用你当前的「基于 tag 创建 GitHub Release」的步骤（保持对用户体验不变）。

### 5.2 kosong 发布 workflow

不创建 GitHub Release，只发 PyPI + 生成 docs。

- **触发**：`on push tags` 匹配 `kosong-*`。
- **版本校验**：从 tag 去掉前缀 `kosong-` 得到版本号，必须等于 `packages/kosong/pyproject.toml` 的 `[project].version`。
- **构建**：`uv build --package kosong`（注意 package 名是 `project.name`，不是目录名），输出到 `dist/kosong`。
- **发布**：只把 `dist/kosong` 下的产物发 PyPI。
- **不创建 GitHub Release**：workflow 里不要调用任何 release 创建 action。

### 5.3 pykaos 发布 workflow

不创建 GitHub Release，只发 PyPI。

- **触发**：`on push tags` 匹配 `pykaos-*`。
- **版本校验**：从 tag 去掉前缀 `pykaos-` 得到版本号，必须等于 `packages/kaos/pyproject.toml` 的 `[project].version`。
- **构建**：`uv build --package pykaos`，输出到 `dist/pykaos`。
- **发布**：只把 `dist/pykaos` 下的产物发 PyPI。
- **不创建 GitHub Release**。

## 6. 发版时的「tag 与版本一致」校验实现方式

建议统一为一个可复用脚本。

1. 在仓库里加一个小脚本，例如 `scripts/check_version_tag.py`：
    - 输入：包的 pyproject 路径 + 期望版本（由 tag 派生）。
    - 逻辑：读 `tomllib` -> `project.version` -> 比较 -> 不一致 `exit 1`。
2. 三个 workflow 在 build 前都调用它：
    - `kimi-cli`：期望版本 = `${GITHUB_REF_NAME}`，pyproject = `./pyproject.toml`
    - `kosong`：期望版本 = 去掉 `kosong-`，pyproject = `packages/kosong/pyproject.toml`
    - `pykaos`：期望版本 = 去掉 `pykaos-`，pyproject = `packages/kaos/pyproject.toml`

## 7. kosong 文档 URL 不变的实现

关键：保留旧仓库作为 Pages 承载。

你要「搬代码但 URL 不变」，实际等价于：`MoonshotAI/kosong` 这个仓库必须继续存在并继续作为 GitHub Pages 的站点源；只是文档内容不再在那边构建，而是在 monorepo 构建后推送过去。

具体落地步骤：

1. 在旧的 `MoonshotAI/kosong` 仓库里，把它转为「承载站点的空壳仓库」：
    - main 分支可以只留 README（指向新 monorepo），并建议归档/锁写入，避免误提交。
2. 把该仓库的 GitHub Pages 设置为「从 gh-pages 分支发布」（Deploy from a branch）。
3. 在 monorepo 的 `release-kosong` workflow 里新增 docs 部署步骤：
    - 在 monorepo 里按你原 workflow 的方式生成 docs（你现在是 `uv run pdoc … -o docs`，并创建 `docs/.nojekyll`）。
    - 把生成的 docs 内容推送到旧仓库 `MoonshotAI/kosong` 的 gh-pages 分支（覆盖更新）。
4. 权限：给 monorepo 配一个能写 `MoonshotAI/kosong` 的凭据：
    - 推荐 fine-grained PAT（仅对该仓库 `contents:write`），作为 monorepo 的 secret（例如 `KOSONG_PAGES_TOKEN`）。

这样访问 URL 仍然是原来的 URL，但文档内容来自 monorepo 的发版构建产物。

## 8. 最终切换/上线顺序

降低风险的执行顺序。

1. 在 `kimi-cli` 仓库开迁移分支，先完成 workspace 配置与 subtree 导入，跑通本地开发与测试。
2. 把三个 release workflow 都先改成「仅在特定 tag 前缀触发」，并在 PR 环境用手工 dispatch 或临时 tag 在测试 PyPI/私有 index 验证（如果你们有的话；没有就用 dry-run 构建检查）。
3. 先发布一个 `pykaos-` 与 `kosong-` 的小版本（哪怕只是 patch），验证：
    - tag -> 版本校验能挡住错误
    - PyPI 包发布产物正确
    - kosong 文档被成功推到旧仓库且 URL 不变
4. 最后按原方式发布 `kimi-cli` 的数字 tag（`0.68.1` 之类），验证 GitHub Release 页仍只出现 `kimi-cli`。

---

如果你希望我把「最终三个 workflow 的 YAML 骨架」直接写出来（包含：tag 解析、版本校验脚本调用、`uv build --package`、发布、以及 kosong docs 推送到旧仓库 gh-pages），我可以按你们现有的 `release.yml` 结构（你给的 `MoonshotAI/kosong` 版本）做「最小改动迁移版」，确保你们维护成本最低。
