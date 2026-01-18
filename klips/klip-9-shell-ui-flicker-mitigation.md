---
Author: "@stdrc"
Updated: 2026-01-19
Status: Implemented
---

# KLIP-9: Shell UI 闪烁缓解 — Pager 展开方案

## 问题背景

### 终端渲染的根本限制

终端有两个区域：**viewport**（可见区域，可原地更新）和 **scrollback**（历史区域，不可变）。

当 Live display 内容高度超过 viewport：
1. 顶部内容被推入 scrollback
2. Scrollback 不可变，光标无法定位
3. 任何更新都需要清除整个 scrollback 并重绘 → **闪烁**

### 当前问题

1. **Approval Request 过高**：Shell tool 的命令直接放在 `description` 中，长命令导致 panel 过高
2. **Display 字段未渲染**：`ApprovalRequest.display` 字段（包含 DiffDisplayBlock）在 UI 中**完全没有渲染**
3. **无法查看完整内容**：用户无法看到被截断的完整信息

## 方案设计

### 核心思路

1. **统一行预算**：所有内容共享固定行数预算（4 行），按顺序渲染直到预算用完
2. **Ctrl+E 展开到 Pager**：使用 Rich 的 `console.pager(styles=True)` 显示完整内容
3. **修复 display 字段渲染**：正确显示 DiffDisplayBlock 和 ShellDisplayBlock

### 为什么用 Pager

1. **已有实践**：项目在 `/help`、`/context`、`/debug history` 中已使用 `console.pager()`
2. **Alternate Screen**：Pager（less）使用 alternate screen，与 Live display 完全隔离
3. **零闪烁**：退出 pager 后，终端恢复到之前状态，Live display 继续工作
4. **功能丰富**：支持搜索（/）、滚动（j/k）、翻页（Space）等

### UI 设计

#### 截断显示（默认）

无边框设计，内容区最多显示 4 行：

```
  ⚠ shell is requesting approval to Run command:

    pip install requests pandas numpy matplotlib \
        scikit-learn tensorflow torch transformers \
        fastapi uvicorn sqlalchemy alembic pytest
    ... (truncated, ctrl-e to expand)

  → Approve once
    Approve for this session
    Reject, tell Kimi CLI what to do instead
```

#### 文件编辑的 Diff 显示

同一文件多个 hunk 时，后续 hunk 使用 `⋮` 表示省略的中间行：

```
  ⚠ str_replace is requesting approval to Edit file:

    src/main.ts
    @@ -10,3 +10,5 @@
     import { foo } from './foo';
    -import { bar } from './bar';
    ... (truncated, ctrl-e to expand)

  → Approve once
    ...
```

多个 hunk 完整显示时（pager 内）：

```
  src/main.ts
  @@ -10,3 +10,5 @@
   import { foo } from './foo';
  -import { bar } from './bar';
  +import { bar, baz } from './bar';
  +import { qux } from './qux';

  ⋮
  @@ -50,3 +52,4 @@
   export function main() {
  -    const result = foo() + bar();
  +    const result = foo() + bar() + baz() + qux();
```

#### Pager 全屏视图（Ctrl+E）

按 Ctrl+E 后进入系统 pager（通常是 less），复用预渲染的内容，显示完整信息。

## 实现细节

### 1. 新增 ShellDisplayBlock

```python
# tools/display.py

class ShellDisplayBlock(DisplayBlock):
    """Display block describing a shell command."""

    type: str = "shell"
    language: str
    command: str
```

### 2. 预渲染内容块

使用 NamedTuple 存储预渲染的内容块及其行数：

```python
class _ApprovalContentBlock(NamedTuple):
    """A pre-rendered content block for approval request with line count."""

    text: str
    lines: int
    style: str = ""
    lexer: str = ""
```

在 `_ApprovalRequestPanel.__init__` 中预渲染所有内容：

```python
class _ApprovalRequestPanel:
    def __init__(self, request: ApprovalRequest):
        # Pre-render all content blocks with line counts
        self._content_blocks: list[_ApprovalContentBlock] = []
        last_diff_path: str | None = None

        # Handle display blocks
        for block in request.display:
            if isinstance(block, DiffDisplayBlock):
                # File path or ellipsis for same-file hunks
                if block.path != last_diff_path:
                    self._content_blocks.append(
                        _ApprovalContentBlock(text=block.path, lines=1, style="bold")
                    )
                    last_diff_path = block.path
                else:
                    self._content_blocks.append(
                        _ApprovalContentBlock(text="⋮", lines=1, style="dim")
                    )
                # Diff content
                diff_text = format_unified_diff(...).rstrip("\n")
                self._content_blocks.append(
                    _ApprovalContentBlock(
                        text=diff_text, lines=diff_text.count("\n") + 1, lexer="diff"
                    )
                )
            elif isinstance(block, ShellDisplayBlock):
                text = block.command.rstrip("\n")
                self._content_blocks.append(
                    _ApprovalContentBlock(
                        text=text, lines=text.count("\n") + 1, lexer=block.language
                    )
                )
            # ...

        self._total_lines = sum(b.lines for b in self._content_blocks)
        self.has_expandable_content = self._total_lines > MAX_PREVIEW_LINES
```

### 3. 统一行预算渲染

```python
def render(self) -> RenderableType:
    content_lines: list[RenderableType] = [
        Text.from_markup(
            "[yellow]⚠ "
            f"{escape(self.request.sender)} is requesting approval to "
            f"{escape(self.request.action)}:[/yellow]"
        )
    ]
    content_lines.append(Text(""))

    # Render content with line budget
    remaining = MAX_PREVIEW_LINES
    for block in self._content_blocks:
        if remaining <= 0:
            break
        content_lines.append(self._render_block(block, remaining))
        remaining -= min(block.lines, remaining)

    if self.has_expandable_content:
        content_lines.append(
            Text("... (truncated, ctrl-e to expand)", style="dim italic")
        )

    # ... menu options ...
    return Padding(Group(*lines), 1)
```

### 4. Pager 复用预渲染内容

```python
def render_full(self) -> list[RenderableType]:
    """Render full content for pager (no truncation)."""
    return [self._render_block(block) for block in self._content_blocks]


def _show_approval_in_pager(panel: _ApprovalRequestPanel) -> None:
    """Show the full approval request content in a pager."""
    with console.screen(), console.pager(styles=True):
        # Header
        console.print(
            Text.from_markup(
                "[yellow]⚠ "
                f"{escape(panel.request.sender)} is requesting approval to "
                f"{escape(panel.request.action)}:[/yellow]"
            )
        )
        console.print()

        # Render full content (no truncation)
        for renderable in panel.render_full():
            console.print(renderable)
```

### 5. KeyboardListener 支持 Pause/Resume

为了在 pager 活动时暂停键盘监听，新增 `KeyboardListener` 类：

```python
class KeyboardListener:
    async def start(self) -> None: ...
    async def stop(self) -> None: ...
    async def pause(self) -> None: ...
    async def resume(self) -> None: ...
    async def get(self) -> KeyEvent: ...
```

键盘处理中使用 pause/resume：

```python
async def keyboard_handler(listener: KeyboardListener, event: KeyEvent) -> None:
    if event == KeyEvent.CTRL_E:
        if (
            self._current_approval_request_panel
            and self._current_approval_request_panel.has_expandable_content
        ):
            await listener.pause()
            live.stop()
            try:
                _show_approval_in_pager(self._current_approval_request_panel)
            finally:
                self._reset_live_shape(live)
                live.start()
                live.update(self.compose(), refresh=True)
                await listener.resume()
        return
    # ... handle other events ...
```

## 变更范围

| 文件 | 变更 |
|------|------|
| `tools/display.py` | 新增 `ShellDisplayBlock` |
| `ui/shell/visualize.py` | 预渲染内容块、统一行预算、pager 展开、无边框设计 |
| `ui/shell/keyboard.py` | 新增 `KeyboardListener` 类支持 pause/resume、添加 `CTRL_E` 事件 |
| `tools/shell/__init__.py` | 使用 `ShellDisplayBlock` 传递命令 |
| `utils/diff.py` | 新增 `format_unified_diff` 函数 |
| `utils/rich/syntax.py` | 新增 `KimiSyntax` 支持自定义主题 |

## 设计决策

1. **Ctrl+E 而非 Ctrl+O**：E 代表 Expand，更直观
2. **无边框设计**：移除 Panel 边框，使用 Padding，更简洁
3. **统一行预算**：所有内容共享 4 行预算，避免多个 block 导致高度爆炸
4. **简化截断提示**：只显示 `... (truncated, ctrl-e to expand)`，不显示具体行数
5. **预渲染复用**：preview 和 pager 共享预渲染的内容块，避免重复计算
6. **同文件多 hunk**：使用 `⋮` 表示省略的中间行，而非重复显示文件名

## 边界情况

1. **短内容**：如果内容不需要截断，不显示截断提示，`has_expandable_content` 为 False
2. **无 display**：如果只有 description 没有 display blocks，也正确处理
3. **多个 DiffDisplayBlock**：统一行预算，可能只显示第一个 block 的部分内容
4. **Pager 不可用**：Rich 会 fallback 到直接输出

## 测试计划

1. 短命令的 approval request（不截断）
2. 长命令的 approval request（截断 + Ctrl+E 展开）
3. 文件编辑的 approval request（diff 显示 + Ctrl+E 展开）
4. 同一文件多个 hunk（显示 `⋮`）
5. 从 pager 返回后 Live display 正常工作
6. 在 pager 中按 q 退出、按 / 搜索等
