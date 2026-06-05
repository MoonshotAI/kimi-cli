# 引导用户从 Kimi CLI 迁移到 Kimi Code —— 设计文档

- 日期：2026-06-05
- 状态：待评审
- 范围：在 kimi-cli（本仓库，Python 版）内新增/强化迁移引导，把用户导向继任产品 Kimi Code（独立单二进制版，仓库 https://github.com/MoonshotAI/kimi-code）

## 1. 背景与现状

- **kimi-cli**（本仓库）：初代终端 Agent，PyPI 安装，数据目录 `~/.kimi/`。内部已部分改名 "Kimi Code CLI"（`constant.py: NAME`）。本仓库还带一个 `packages/kimi-code` 的 PyPI 别名包（`kimi-code` 包 → 依赖 `kimi-cli`，提供同名 `kimi-code` 命令，实际仍是旧版）。
- **kimi-code**（继任产品，独立仓库）：重写的单二进制版，curl 一行安装，不依赖 Python/Node，启动飞快，主打 video input / MCP / subagents / hooks。数据目录 `~/.kimi-code/`，**启动命令同样是 `kimi`**。安装时会**自动迁移**旧版的配置与会话（已验证）。

现有引导（均偏被动）：
1. `README.md` 顶部 IMPORTANT banner。
2. 文档首页 `docs/index.md` hero 已改名。
3. 运行时欢迎屏一条单行 Tip（`src/kimi_cli/app.py:771`）。

## 2. 目标与原则

- **目标**：在不制造焦虑、不强制的前提下，把"从 kimi-cli 迁到 kimi-code"的摩擦降到最低，并在用户有意图的时刻（启动、退出、主动求助）轻量、反复地提示。
- **主信息**（贯穿所有触点）：*"换 Kimi Code —— 更快、单二进制；配置和会话自动迁移。"* 自动迁移已验证，是最强卖点，须放在最显眼处。
- **强度定位**：主动协助（T1 + T2），不做强制（不做倒计时 / 不做强制 interstitial / 不做到期阻断）。

## 3. 已确认的决策

| 项 | 决策 |
|---|---|
| 引导强度 | 主动协助为主（T1 强化提示 + T2 一键迁移命令） |
| 自动迁移 | 已可用且验证过 → 可放心承诺"配置/会话自动带过去" |
| 下线计划 | 不硬性下线 → 文案软化为"推荐升级、老安装继续可用"，不做紧迫感倒计时 |
| `/upgrade` 行为 | 带确认地替用户执行安装脚本 |
| 退出提示 | 节流：每天最多一次 |
| 已装检测 | 检测 `~/.kimi-code/` 目录是否存在 |

安装命令（取自 kimi-code 仓库，权威来源）：
- macOS/Linux：`curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash`
- Windows（PowerShell）：`irm https://code.kimi.com/kimi-code/install.ps1 | iex`
- 备选（npm）：`npm install -g @moonshot-ai/kimi-code`

## 4. 关键风险 / 坑（必须处理）

1. **命令名撞车**：新旧工具的启动命令都是 `kimi`，由 PATH 优先级决定谁生效。`/upgrade` 装完**不能**提示"运行 `kimi-code`"，而应提示"开新终端运行 `kimi`，并用 `which kimi` 确认指向 `~/.kimi-code`"。
2. **无法热替换当前进程**：`/upgrade` 安装后，当前正在跑的仍是旧 Python 进程、PATH 也才刚改。不要尝试在会话内 exec 切换；提示用户开新终端即可。
3. **别名包误导**：本仓库的 `packages/kimi-code` 让 `pip install kimi-code` 装回的还是旧版。建议给该别名包加启动自报"这是旧版 CLI，新版在 …"（附带项，见 §5.6）。
4. **数据目录区分**：旧版 `~/.kimi/`，新版 `~/.kimi-code/`。触点②用 `~/.kimi-code/` 检测，已确认不会与旧版冲突。
5. **节流状态持久化**：退出提示的"每天一次"需要一个持久化的"上次展示日期"，存放位置见 §5.4。

## 5. 触点设计

### 5.1 触点①：`/upgrade` slash 命令（核心，T2）

- **落点**：`src/kimi_cli/ui/shell/slash.py`（与现有 feedback / open-web-ui 命令同构注册）。
- **流程**：
  1. 检测平台（darwin/linux → bash 安装命令；win32 → PowerShell 安装命令；其余 → 打印 npm 备选 + 文档链接）。
  2. 打印**将要运行的完整安装命令**，请用户确认（默认 No）。
  3. 确认后在子进程执行安装命令（继承终端，让安装器自己的交互/进度正常显示）。
  4. 成功后打印后续指引（见 §6 文案）；失败则打印命令让用户手动执行 + 文档链接。
- **不做**：不在会话内热替换进程；不假设安装目录可写之外的任何副作用。

### 5.2 触点②：启动检测已装 kimi-code（T2）

- **落点**：`src/kimi_cli/app.py` 构建 welcome_info 处。
- **逻辑**：若 `~/.kimi-code/` 存在 → 追加一条 welcome 项，提示"你已装好 Kimi Code，开新终端用 `kimi` 即可（`which kimi` 确认指向 `~/.kimi-code`）"。
- **语义**：本段代码只可能在旧版进程里执行；`~/.kimi-code/` 存在即"用户已装新版但当前仍在跑旧版"，是强引导时机。

### 5.3 触点③：强化启动欢迎卡片（T1）

- **落点**：`src/kimi_cli/app.py:771` 现有那条单行 Tip。
- **改动**：扩成紧凑小卡 —— 标题 + 1~2 个硬卖点（单二进制 / 秒级启动 / video input）+ 一行 `/upgrade` 指引（见 §6）。保持简短，不喧宾夺主。
- 与触点②互斥/共存：若②已提示"已装"，③可弱化为单行或不显示（避免重复）。实现期决定。

### 5.4 触点④：退出提示（T1，节流每天一次）

- **落点**：`src/kimi_cli/ui/shell` 的退出路径（`/quit`、`Ctrl-D`）。
- **节流**：读写一个"上次展示日期"，存于 `~/.kimi/`（旧版数据目录，例如 `~/.kimi/.migration-nudge` 或 config 内字段）；同一自然日只展示一次。
- **文案**：见 §6。

### 5.5 触点⑤：文档 / README 收尾（T0）

- 文档**每页**顶部 banner（改 vitepress layout / 公共组件），不只首页。
- 新增一篇《从 Kimi CLI 迁移到 Kimi Code》指南页（安装命令 + 自动迁移说明 + 命令名撞车提示 + 常见问题）。
- `README.md` 新增 "Migrating" 小节（一行命令 + 自动迁移说明）。
- **软化下线措辞**：将 README/banner 中 "will be gradually wound down" 改为"推荐升级、老安装继续可用"的口吻（对齐"不硬性下线"决策）。

### 5.6 附带项（要不要做由用户定）

- 给 `packages/kimi-code` 别名包加启动自报，堵 `pip install kimi-code` 落回旧版的坑。

## 6. UI 文案（English，产品面向英文用户）

启动欢迎卡片（触点③）：
```
Kimi Code is here — the faster, single-binary successor to Kimi CLI.
  • Single binary, no Python/Node   • Instant startup   • Video input, subagents, hooks
Run /upgrade to switch — your config & sessions migrate automatically.
```

退出提示（触点④，节流每天一次）：
```
Tip: Kimi Code is faster and migrates your config & sessions automatically.
Install: curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash   (or run /upgrade next time)
```

`/upgrade` 确认前（触点①）：
```
This will install Kimi Code by running:
  curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash
Your existing config & sessions will be migrated automatically.
Proceed? [y/N]
```

`/upgrade` 成功后（触点①）：
```
Kimi Code installed ✓  Your config & sessions were migrated automatically.
Open a NEW terminal and run `kimi` to start Kimi Code.
(Verify with `which kimi` — it should point inside ~/.kimi-code.)
```

已装检测（触点②）：
```
Kimi Code is already installed on this machine.
Start it in a fresh terminal with `kimi` (verify: `which kimi` → ~/.kimi-code).
```

## 7. 明确不做（YAGNI）

- sunset 倒计时、首次运行强制 interstitial、到期启动阻断 —— 全部不做。
- 不在 kimi-cli 内重实现迁移逻辑（迁移由 kimi-code 安装器负责，已验证）。

## 8. 测试策略

遵循"先写失败测试再实现"：
- 触点①：平台检测分支（darwin/linux/win32/其他）选对命令；确认为 No 时不执行；子进程调用被正确构造（mock 掉实际执行）。
- 触点②：`~/.kimi-code/` 存在/不存在 → welcome 项出现/不出现（用临时 HOME 隔离）。
- 触点④：节流逻辑 —— 同日第二次不展示、跨日重新展示（注入可控日期，避免依赖真实时钟）。
- 文档改动：现有文档相关测试不破。

## 9. 实现期待确认项

- 触点②/③ 共存时的去重显示策略（避免"已装提示"和"升级卡片"同屏重复）。
- npm 备选文案是否需要在 `/upgrade` 的"其他平台"分支展示。
- 退出提示节流状态的具体落盘形式（独立标记文件 vs. config 字段）。
