---
Author: "@stdrc"
Updated: 2026-01-19
Status: In Progress
---

# KLIP-11: Rename Kimi CLI -> Kimi Code (Dual PyPI Packages)

## 背景

当前项目品牌为 Kimi CLI，PyPI 包名为 `kimi-cli`。需求是将项目整体更名为 Kimi Code，
并在 PyPI 上发布新包 `kimi-code`，同时保持 `kimi-cli` 包与 `kimi-code` 包内容完全一致。

## 目标

- 对外品牌统一为 **Kimi Code**（文案、文档、UI、元数据、User-Agent 等用户可见内容）。
- PyPI 发布 **`kimi-code`** 包。
- `kimi-cli` 继续发布，且与 `kimi-code` 内容保持一致（同一源码、同一版本、同一入口）。
- 保持兼容：`kimi` 命令与 `kimi_cli` 模块可继续使用。

## 非目标/约束

- 不迁移用户本地数据目录（保持 `~/.kimi`）。
- 不改 Python 包导入路径（保持 `kimi_cli`）。
- 不移除 `kimi-cli` 入口（仅做兼容/别名）。

## 关键决策点（需要确认）

- `project.name` 是否以 `kimi-code` 为主，`kimi-cli` 作为“二次构建”的 legacy 包。
- 是否新增控制台入口 `kimi-code`（保留 `kimi` 与 `kimi-cli`）。
- 是否调整文档站点路径（`moonshotai.github.io/kimi-code` 还是保留旧路径并加重定向）。
- CDN 与二进制下载路径是否迁移到 `binaries/kimi-code`，以及旧路径是否保留镜像。

## 阶段划分（两个阶段）

### 阶段 1（DDL 更近）：用户视角 Rebrand 优先

优先处理所有“用户可见/可感知”的内容：文档、文案、标题、CLI 输出、提示语、User-Agent。
代码层面的包结构与导入名不是阶段 1 的关键目标。

### 阶段 2：内部替换与清理

在对外已完成 Rebrand 后，逐步替换内部命名与遗留结构（包名、模块、CI 细节等）。

## 当前进度（已完成）

- **薄包装包**：新增 `packages/kimi-code/`，依赖 `kimi-cli==<version>`，并提供
  `kimi` 与 `kimi-code` 入口（共用 `kimi_cli.cli:cli`）。
- **工作区接入**：将 `packages/kimi-code` 加入 workspace，且在 `tool.uv.sources` 中
  声明 `kimi-cli` 来自 workspace，避免 `uv sync` 报错。
- **构建入口**：`make build-kimi-cli` 同时构建 `kimi-cli` 与 `kimi-code` 到 `dist/`。
- **发布流程**：`release-kimi-cli.yml` 增加 `kimi-code` 版本校验，并随发布构建 `kimi-code`。
- **README**：`packages/kimi-code/README.md` 软链接到根目录 `README.md`。

## 计划（分门别类）

### 1) 用户视角 Rebrand（阶段 1 优先）

- **CLI 文案/标题**：将用户可见的 `Kimi CLI` 文案改为 `Kimi Code`，覆盖：
  - `src/kimi_cli/constant.py`（`NAME`、`USER_AGENT`）
  - `src/kimi_cli/cli/__init__.py` / `src/kimi_cli/cli/info.py`
  - `src/kimi_cli/ui/shell/*`（欢迎语、升级提示、setup 提示）
  - `src/kimi_cli/agents/default/system.md`
  - `src/kimi_cli/exception.py`, `src/kimi_cli/tools/AGENTS.md`,
    `src/kimi_cli/acp/AGENTS.md`
- **User-Agent**：`USER_AGENT` 由 `KimiCLI/<version>` 改为 `KimiCode/<version>`。
- **文档标题/描述/导航**：更新 `docs/.vitepress/config.ts`、`docs/index.md`、站点标题与
  版本页标题。
- **README 与官网链接**：更新 `README.md`、docs 中的品牌与徽章文案。
- **安装/升级文案**：将 `uv tool install/upgrade kimi-cli` 等提示改为 `kimi-code`，
  并在必要处保留兼容说明。

### 2) 包发布与版本策略（Dual Dist）

- **发布策略设计**：确定 `kimi-code` 与 `kimi-cli` 双包共源的打包方案。
  - 方案 A：根 `pyproject.toml` 改为 `kimi-code`，新增一个 legacy 包目录（如
    `packages/kimi-cli/pyproject.toml`）复用 `src/kimi_cli`。
  - 方案 B：保持根包为 `kimi-cli`，新增 `packages/kimi-code/` 做镜像包。
  - 方案 C：引入脚本在构建时生成临时 `pyproject` 并打包两个 dist。
- **版本一致性**：确保两个 dist 版本号一致，构建/发布时同步。
- **代码内版本读取**：`src/kimi_cli/constant.py` 改为优先读取 `kimi-code`，并回退到
  `kimi-cli`（避免单包安装时报错）。
- **构建入口**：更新 `Makefile`、`uv.lock`、`scripts/check_kimi_dependency_versions.py`
  以支持双包构建与校验。

### 3) 更新通道与安装脚本

- **二进制更新 URL**：`src/kimi_cli/ui/shell/update.py` 的 `BASE_URL` 改为
  `binaries/kimi-code`，并保留对旧 `binaries/kimi-cli` 的回退或镜像。
- **内置 RG 下载 URL**：`src/kimi_cli/tools/file/grep_local.py` 的 `RG_BASE_URL` 同步更新，
  保持兼容。
- **安装脚本**：`scripts/install.sh` / `scripts/install.ps1` 改为安装 `kimi-code`。
- **文档安装命令**：`docs/en|zh/guides/getting-started.md` 等处更新命令与 URL。

### 4) 文档站点与仓库链接

- **文档标题/描述**：更新 `docs/.vitepress/config.ts`，`docs/package.json` 名称。
- **站点链接**：更新 README、文档、Issue 模板、PR 模板中的 GitHub 链接与 badges。
- **Docs URL**：全局替换 `moonshotai.github.io/kimi-cli` 为新路径（若决策迁移），并规划
  旧路径重定向或公告。
- **迁移说明**：新增或更新文档页说明 `kimi-cli` 为 legacy 包，`kimi-code` 为新包。
- **Breaking change 文档**：在 `docs/en|zh/release-notes/breaking-changes.md` 的
  Unreleased 部分增加迁移说明：
  - 建议 `uv tool uninstall kimi-cli` 后再 `uv tool install kimi-code`
  - 明确说明用户 metadata 与配置文件不会丢失（仍在 `~/.kimi`）

### 5) 示例工程与测试覆盖（阶段 1 后半）

- **示例包名**：更新 `examples/*` 目录、README、`pyproject.toml` 依赖从 `kimi-cli` 到
  `kimi-code`（必要时保留兼容说明）。
- **测试与断言**：更新 `tests/*` 中对 `Kimi CLI` 字符串、skill 路径的断言。
- **回归测试**：新增或更新测试以验证 `kimi-code` 与 `kimi-cli` 双包运行一致。

### 6) CI/Release/Nix/二进制产物

- **CI Workflow**：更新 `.github/workflows/ci-kimi-cli.yml` / `release-kimi-cli.yml`，
  新增 `kimi-code` 的构建与发布步骤，保留 `kimi-cli` 发布。
- **Nix flake**：在 `flake.nix` 中提供 `kimi-code` 包，同时保留 `kimi-cli` 输出别名。
- **PyInstaller**：确认 `kimi.spec` 产物命名策略（CLI 二进制继续叫 `kimi`）。

### 7) 迁移策略与发布节奏

- **阶段 1**：完成用户视角 Rebrand（文档/文案/标题/输出/User-Agent），并提供
  `kimi-code` 包与发布流程。
- **阶段 2**：替换内部命名与遗留结构（包名、模块、CI/Nix 等细节），逐步清理 `kimi-cli`
  的内部痕迹。
- **阶段 3**：更新 CI/CD 与 CDN 镜像，确保二进制更新链路无中断。
- **阶段 4**：增加 deprecation 通知（如在 `kimi-cli` 安装时提示迁移）。
