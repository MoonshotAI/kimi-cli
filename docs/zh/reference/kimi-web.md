# `kimi web` 命令

`kimi web` 用于启动 Web UI 服务器，让你在浏览器中使用 Kimi Code CLI。

```sh
kimi web [OPTIONS]
```

## 用法

### 基本用法

在项目目录中运行以下命令启动 Web UI：

```sh
kimi web
```

启动后，会自动打开浏览器访问 Web 界面。默认绑定到 `127.0.0.1:5494`，只允许本机访问。
如果默认端口被占用，服务器会自动尝试下一个可用端口（默认范围 `5494`–`5503`），并在终端打印提示。

### 常用选项

| 选项 | 简写 | 说明 |
|------|------|------|
| `--network` | `-n` | 启用网络访问（绑定到 `0.0.0.0`） |
| `--host TEXT` | `-h` | 绑定到指定 IP 地址 |
| `--port INTEGER` | `-p` | 绑定的端口号（默认：`5494`） |
| `--open / --no-open` | | 是否自动打开浏览器（默认：`--open`） |
| `--lan-only / --public` | | 仅允许局域网访问（默认）或允许公网访问 |
| `--auth-token TEXT` | | 指定鉴权 Token（网络模式未指定时自动生成） |
| `--allowed-origins TEXT` | | 允许的 Origin 列表（逗号分隔，默认自动检测） |
| `--dangerously-omit-auth` | | 禁用鉴权（危险，仅建议在完全受信任环境使用） |
| `--restrict-sensitive-apis / --no-restrict-sensitive-apis` | | 禁用/启用敏感 API（网络模式默认启用限制） |

### 开发模式

```sh
# 启用自动重载（修改代码后自动重启服务器）
kimi web --reload
```

## 功能特性

Web UI 提供了与终端 Shell 模式相似的功能：

- **聊天界面**：与 Kimi Code CLI 进行自然语言对话
- **会话管理**：创建、切换和管理多个会话，支持按标题或工作目录搜索筛选
- **文件操作**：上传和查看文件
- **审批控制**：审批或拒绝 Agent 的操作请求
- **配置管理**：调整 Thinking 模式等设置
- **Git 状态栏**：实时显示会话工作目录中的未提交变更
- **快速打开**：通过 "Open in" 菜单在终端、VS Code、Cursor 等应用中打开文件或目录

## 访问模式

### 本机模式（默认）

默认情况下，`kimi web` 只绑定到 `127.0.0.1`，仅允许本机访问：

```sh
kimi web
```

启动后终端显示：
```
  ➜  Local    http://127.0.0.1:5494
```

本机模式无需鉴权 Token。

### 局域网模式

使用 `--network` 或 `-n` 选项启用网络访问：

```sh
kimi web --network
# 或
kimi web -n
```

启动后终端显示：
```
  ➜  Local    http://localhost:5494/?token=xxx...
  ➜  Network  http://192.168.1.100:5494/?token=xxx...
```

局域网模式默认为 `--lan-only`，只允许来自私有 IP 地址的访问：
- `10.0.0.0/8`
- `172.16.0.0/12`
- `192.168.0.0/16`
- `127.0.0.0/8`（localhost）

### 公网模式

如果需要允许公网访问（如通过公网 IP 或内网穿透），添加 `--public` 选项：

```sh
kimi web --network --public
```

::: danger 安全警告
公网模式允许任何能访问到服务器的设备连接。请确保：
- 使用强随机 Token（自动生成）
- 不要在不信任的网络中使用
- 考虑配合防火墙或 VPN 使用
:::

### 手动指定 IP

使用 `--host` 选项绑定到指定 IP 地址：

```sh
# 绑定到特定 IP（局域网模式）
kimi web --host 192.168.1.100

# 绑定到特定 IP（公网模式）
kimi web --host 192.168.1.100 --public
```

## 鉴权机制

当启用网络访问（`--network` 或 `--host` 非本地地址）时会自动启用鉴权：

- 自动生成随机 Token（如需固定 Token 可使用 `--auth-token`）
- 终端会打印 Token，并给出带 `?token=` 的访问链接
- HTTP API 通过 `Authorization: Bearer <token>` 鉴权
- WebSocket 通过 `?token=<token>` 鉴权

## Origin 限制

为防止 DNS Rebinding，使用 `--network` 时会自动检测本机所有网络地址并添加到允许列表。
如需手动指定，可使用：

```sh
kimi web --network --allowed-origins http://192.168.1.20:5494,http://10.0.0.5:5494
```

## 敏感 API 限制

网络模式默认限制敏感 API（配置写入、open-in、文件访问限制等）。如需关闭限制：

```sh
kimi web --network --no-restrict-sensitive-apis
```

## 危险模式（不建议）

如需完全关闭鉴权（强烈不建议），使用：

```sh
kimi web --network --dangerously-omit-auth
```

启动时会要求输入 `I UNDERSTAND THE RISKS` 进行确认。

::: warning 安全提示
在公共网络中开放访问存在高风险，建议仅在受信任的网络环境中使用。
:::
