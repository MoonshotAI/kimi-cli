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
- **创建会话**：指定工作目录创建新会话
- **切换会话**：一键切换到不同的会话

::: info 新增
会话搜索功能新增于 1.5 版本。
:::

### Git 状态栏

Web UI 会在会话工作目录中检测 Git 仓库状态，并在界面顶部显示未提交的更改统计：

- 新增文件数量
- 修改文件数量
- 删除文件数量

点击状态栏可以查看详细的文件变更列表。

::: info 新增
Git 状态栏新增于 1.5 版本。
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
