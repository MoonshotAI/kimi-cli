# Web UI

Web UI 提供了基于浏览器的交互界面，让你可以在网页中使用 Kimi Code CLI 的所有功能。相比终端界面，Web UI 提供了更丰富的视觉体验、更灵活的会话管理以及更便捷的文件操作。

## 启动 Web UI

在终端中运行 `kimi web` 命令启动 Web UI 服务器：

```sh
kimi web
```

服务器启动后会自动打开浏览器访问 Web UI。默认地址为 `http://127.0.0.1:5494`。

如果默认端口被占用，服务器会自动尝试下一个可用端口（默认范围 `5494`–`5503`），并在终端打印访问地址。

## 命令行选项

### 网络配置

| 选项 | 简写 | 说明 |
|------|------|------|
| `--host TEXT` | `-h` | 绑定到指定的 IP 地址 |
| `--network` | `-n` | 启用网络访问（绑定到 `0.0.0.0`） |
| `--port INTEGER` | `-p` | 指定端口号（默认：`5494`） |

默认情况下，Web UI 只监听本地回环地址 `127.0.0.1`，仅允许本机访问。

如果你想在局域网或公网中访问 Web UI，可以使用 `--network` 选项或指定 `--host`：

```sh
# 绑定到所有网络接口，允许局域网访问
kimi web --network

# 绑定到指定 IP 地址
kimi web --host 192.168.1.100
```

::: warning 注意
当启用网络访问时，请务必配置访问控制选项（如 `--auth-token` 和 `--lan-only`）以确保安全。详见 [访问控制](#访问控制)。
:::

### 浏览器控制

| 选项 | 说明 |
|------|------|
| `--open / --no-open` | 启动时自动打开浏览器（默认：`--open`） |

使用 `--no-open` 可以禁止自动打开浏览器：

```sh
kimi web --no-open
```

### 开发选项

| 选项 | 说明 |
|------|------|
| `--reload` | 启用自动重载（用于开发调试） |

使用 `--reload` 可以在代码修改后自动重启服务器：

```sh
kimi web --reload
```

::: info 说明
`--reload` 选项仅用于开发调试，日常使用不需要启用。
:::

### 访问控制

Web UI 提供了多层访问控制机制，确保服务的安全性。

| 选项 | 说明 |
|------|------|
| `--auth-token TEXT` | 设置 Bearer Token 用于 API 认证 |
| `--allowed-origins TEXT` | 设置允许的 Origin 列表（逗号分隔） |
| `--lan-only / --public` | 仅允许局域网访问（默认）或允许公网访问 |
| `--restrict-sensitive-apis / --no-restrict-sensitive-apis` | 限制敏感 API 访问（配置写入、open-in、文件访问限制） |
| `--dangerously-omit-auth` | 禁用认证检查（危险，仅限受信任的网络环境） |

::: info 新增
访问控制选项新增于 1.6 版本。
:::

#### 访问令牌认证

使用 `--auth-token` 可以设置访问令牌，客户端需要在 HTTP 请求头中携带 `Authorization: Bearer <token>` 才能访问 API：

```sh
kimi web --network --auth-token my-secret-token
```

::: tip 提示
访问令牌应该是一个随机生成的字符串，建议至少包含 32 个字符。可以使用 `openssl rand -hex 32` 生成随机令牌。
:::

#### Origin 检查

使用 `--allowed-origins` 可以限制允许访问 Web UI 的来源域名：

```sh
kimi web --network --allowed-origins "https://example.com,https://app.example.com"
```

::: tip 提示
当使用 `--network` 或 `--host` 启用网络访问时，建议配置 `--allowed-origins` 以防止跨站请求伪造（CSRF）攻击。
:::

#### 网络访问范围

默认情况下，Web UI 使用 `--lan-only` 模式，只允许来自局域网（私有 IP 地址段）的访问。如果需要允许公网访问，可以使用 `--public` 选项：

```sh
kimi web --network --public --auth-token my-secret-token
```

::: danger 警告
使用 `--public` 选项会允许任何 IP 地址访问 Web UI，请务必配置 `--auth-token` 和 `--allowed-origins` 以确保安全。
:::

#### 限制敏感 API

使用 `--restrict-sensitive-apis` 可以禁用一些敏感的 API 功能：

- 配置文件写入
- Open-in 功能（打开本地文件、目录、应用）
- 文件访问限制

```sh
kimi web --network --restrict-sensitive-apis
```

在 `--public` 模式下，`--restrict-sensitive-apis` 默认启用；在 `--lan-only` 模式（默认）下则不启用。

::: tip 提示
当你需要将 Web UI 暴露给不受信任的网络环境时，建议启用 `--restrict-sensitive-apis` 选项。
:::

#### 禁用认证（不推荐）

在受信任的私有网络环境中，你可以使用 `--dangerously-omit-auth` 跳过所有认证检查：

```sh
kimi web --dangerously-omit-auth
```

::: danger 警告
`--dangerously-omit-auth` 选项会完全禁用认证和访问控制，仅应在完全受信任的网络环境中使用（如断网的本地开发环境）。不要在公网或不受信任的局域网中使用此选项。
:::

## 从终端切换到 Web UI

如果你正在终端的 Shell 模式中使用 Kimi Code CLI，可以输入 `/web` 命令快速切换到 Web UI：

```
/web
```

执行后，Kimi Code CLI 会自动启动 Web UI 服务器并在浏览器中打开当前会话。你可以继续在 Web UI 中进行对话，会话历史会保持同步。

## Web UI 功能特性

### 会话管理

Web UI 提供了便捷的会话管理界面：

- **会话列表**：查看所有历史会话，包括会话标题和工作目录
- **会话搜索**：通过标题或工作目录快速筛选会话
- **创建会话**：指定工作目录创建新会话；如果指定的路径不存在，会提示确认是否创建目录
- **切换会话**：一键切换到不同的会话
- **会话分支**：从任意 Assistant 回复处创建分支会话，在不影响原会话的情况下探索不同方向
- **会话归档**：超过 15 天的会话会自动归档，你也可以手动归档。归档的会话不会出现在主列表中，但可以随时取消归档
- **批量操作**：在多选模式下批量归档、取消归档或删除会话

::: info 新增
会话搜索功能新增于 1.5 版本。目录自动创建提示新增于 1.7 版本。会话分支、归档和批量操作新增于 1.9 版本。
:::

### 提示工具栏

Web UI 在输入框上方提供统一的提示工具栏，以可折叠标签页的形式展示多种信息：

- **上下文用量**：显示当前上下文的使用百分比，悬停可查看详细的 Token 用量明细（包括输入/输出 Token、缓存读取/写入等）
- **活动状态**：显示 Agent 当前状态（处理中、等待审批等）
- **消息队列**：在 AI 处理过程中可以排队发送后续消息，待当前回复完成后自动发送
- **文件变更**：检测 Git 仓库状态，显示新增、修改和删除的文件数量（包含未跟踪文件），点击可查看详细的变更列表

::: info 变更
Git diff 状态栏新增于 1.5 版本。1.9 版本添加了活动状态指示器。1.10 版本将其统一为提示工具栏。1.11 版本将上下文用量指示器移至提示工具栏。
:::

### Open-in 功能

Web UI 支持在本地应用中打开文件或目录：

- **Open in Terminal**：在终端中打开目录
- **Open in VS Code**：在 VS Code 中打开文件或目录
- **Open in Cursor**：在 Cursor 中打开文件或目录
- **Open in System**：使用系统默认应用打开

::: info 新增
Open-in 功能新增于 1.5 版本。
:::

::: warning 注意
Open-in 功能需要浏览器支持 Custom Protocol Handler 特性。当使用 `--restrict-sensitive-apis` 选项时，此功能会被禁用。
:::

### 斜杠命令

Web UI 支持斜杠命令，在输入框中输入 `/` 即可打开命令菜单：

- **自动补全**：输入命令名称时自动过滤匹配项
- **键盘导航**：使用上下方向键选择命令，Enter 确认
- **别名支持**：支持命令别名匹配，如 `/h` 匹配 `/help`

### 文件提及

Web UI 支持文件提及功能，在输入框中输入 `@` 即可打开文件提及菜单，可以在对话中引用文件：

- **已上传附件**：提及当前消息中已添加的附件文件
- **工作区文件**：提及当前会话工作目录中的已有文件
- **自动补全**：输入时按文件名或路径自动过滤匹配项
- **键盘导航**：使用上下方向键选择文件，Enter 或 Tab 确认，Escape 取消

### 消息操作

Assistant 消息提供以下操作按钮：

- **复制**：一键复制消息内容到剪贴板
- **分支**：从当前回复处创建分支会话

::: info 新增
复制和分支按钮新增于 1.10 版本。
:::

### 审批键盘快捷键

当 Agent 发起审批请求时，你可以使用键盘快捷键快速响应：

| 快捷键 | 操作 |
|--------|------|
| `1` | 批准 |
| `2` | 本次会话批准 |
| `3` | 拒绝 |

::: info 新增
审批键盘快捷键新增于 1.10 版本。
:::

### 工具输出

Web UI 对工具调用的输出提供了丰富的展示方式：

- **媒体预览**：`ReadMediaFile` 工具读取的图片和视频会以可点击的缩略图形式展示
- **Shell 命令**：`Shell` 工具的命令和输出以专用组件渲染
- **Todo 列表**：`SetTodoList` 工具的待办事项以结构化列表展示
- **工具输入参数**：重新设计的工具输入 UI，支持展开查看参数详情，长值带有语法高亮
- **上下文压缩**：上下文压缩进行时会显示压缩指示器

::: info 新增
媒体预览、Shell 命令和 Todo 列表显示组件新增于 1.9 版本。
:::

### 富媒体支持

Web UI 支持查看和粘贴多种类型的富媒体内容：

- **图片**：直接在聊天界面中显示图片
- **代码高亮**：自动识别和高亮代码块
- **Markdown 渲染**：支持完整的 Markdown 语法

### 响应式布局

Web UI 采用响应式设计，可以在不同尺寸的屏幕上良好显示：

- 桌面端：侧边栏 + 主内容区布局
- 移动端：可折叠的抽屉式侧边栏

::: info 变更
响应式布局改进于 1.6 版本，增强了悬停效果和布局处理。
:::

## 示例

### 本地使用

最简单的使用方式，只在本机访问：

```sh
kimi web
```

### 局域网共享

在局域网中共享 Web UI，使用访问令牌保护：

```sh
kimi web --network --auth-token $(openssl rand -hex 32)
```

执行后，终端会显示访问地址和令牌。其他设备可以通过该地址访问，并在浏览器中输入令牌进行认证。

### 公网访问

在公网环境中部署 Web UI（需要谨慎配置安全选项）：

```sh
kimi web \
  --host 0.0.0.0 \
  --public \
  --auth-token $(openssl rand -hex 32) \
  --allowed-origins "https://yourdomain.com" \
  --restrict-sensitive-apis
```

### 开发调试

启用自动重载功能，方便开发调试：

```sh
kimi web --reload --no-open
```

## 技术说明

Web UI 基于以下技术构建：

- **后端**：FastAPI + WebSocket
- **前端**：React + TypeScript + Vite
- **API 协议**：符合 OpenAPI 规范，详见 `web/openapi.json`

Web UI 通过 WebSocket 与 Kimi Code CLI 的 Wire 模式通信，实现实时的双向数据传输。
