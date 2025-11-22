# 从零开始构建 Coding Agent：以 Kimi-CLI 为例

> 一本完整的实践指南，教你如何构建一个功能强大的 AI Coding Agent

## 📖 关于本书

本书将带你从零开始，逐步构建一个像 kimi-cli 这样功能强大的 Coding Agent。你将学习到：

- AI Agent 的核心概念和架构设计
- 如何集成大语言模型（LLM）
- 工具系统（Tools）的设计与实现
- 上下文管理和对话历史
- 多代理协作系统
- 高级特性：时间旅行、思维链、上下文压缩
- 不同的用户界面模式
- 测试、调试和部署

## 🎯 适合人群

- Python 开发者，想要学习 AI Agent 开发
- 对 LLM 应用开发感兴趣的工程师
- 想要构建自己的 AI 助手的开发者
- 希望深入理解 Agent 架构的技术人员

## 📚 章节目录

### 第一部分：基础篇

- **[第 0 章：前言](./00-preface.md)** - 为什么要构建 Coding Agent
- **[第 1 章：核心概念](./01-core-concepts.md)** - Agent、LLM、Tools、Context
- **[第 2 章：环境准备](./02-environment-setup.md)** - 开发环境配置

### 第二部分：基础构建

- **[第 3 章：最简单的 Agent](./03-minimal-agent.md)** - CLI + LLM 基础交互
- **[第 4 章：工具系统设计](./04-tool-system.md)** - Tool Protocol、动态加载
- **[第 5 章：上下文管理](./05-context-management.md)** - 消息历史和持久化

### 第三部分：核心功能

- **[第 6 章：文件操作工具](./06-file-tools.md)** - Read、Write、Grep、Glob
- **[第 7 章：Shell 执行](./07-shell-execution.md)** - 安全执行、超时控制
- **[第 8 章：审批系统](./08-approval-system.md)** - 用户确认机制
- **[第 9 章：Agent 规范](./09-agent-spec.md)** - YAML 配置、系统提示词

### 第四部分：高级特性

- **[第 10 章：多代理系统](./10-multiagent.md)** - Subagents、任务委派
- **[第 11 章：时间旅行](./11-time-travel.md)** - Checkpoint、D-Mail
- **[第 12 章：思维模式](./12-thinking-mode.md)** - Extended Reasoning
- **[第 13 章：上下文压缩](./13-context-compaction.md)** - 内存管理优化

### 第五部分：工程实践

- **[第 14 章：UI 模式](./14-ui-modes.md)** - Shell、Print、ACP、Wire
- **[第 15 章：配置系统](./15-config-system.md)** - 多 LLM 支持、环境变量
- **[第 16 章：会话管理](./16-session-management.md)** - 持久化、继续会话
- **[第 17 章：KAOS 抽象层](./17-kaos-abstraction.md)** - 文件系统抽象

### 第六部分：测试与部署

- **[第 18 章：测试策略](./18-testing.md)** - 单元测试、集成测试
- **[第 19 章：调试技巧](./19-debugging.md)** - 日志、错误处理
- **[第 20 章：部署和分发](./20-deployment.md)** - 打包、发布

### 第七部分：总结

- **[第 21 章：最佳实践](./21-best-practices.md)** - 设计模式、性能优化
- **[第 22 章：未来展望](./22-future.md)** - Agent 技术的未来方向
- **[附录 A：Kimi-CLI 架构总览](./appendix-a-architecture.md)**
- **[附录 B：常用 API 参考](./appendix-b-api-reference.md)**
- **[附录 C：术语表](./appendix-c-glossary.md)**

## 🚀 如何使用本书

1. **顺序阅读**：建议按章节顺序学习，每章都基于前面的内容
2. **动手实践**：每章都有代码示例，请亲自编写和运行
3. **参考源码**：随时查看 kimi-cli 的源代码作为参考
4. **循序渐进**：不要急于求成，理解每个概念后再进入下一章

## 💻 配套代码

每章的代码示例都在对应的 `code/` 目录下：

```
kimi-tutorial/
├── code/
│   ├── chapter-03/  # 第 3 章代码
│   ├── chapter-04/  # 第 4 章代码
│   └── ...
```

## 🤝 贡献

欢迎提交问题、建议和改进！

## 📄 许可证

本教程基于 kimi-cli 项目创建，仅供学习参考。

---

**开始你的 AI Agent 开发之旅吧！** 🎉
