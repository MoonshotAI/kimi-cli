import { defineConfig } from 'vitepress'
import { withMermaid } from 'vitepress-plugin-mermaid'
import llmstxt from 'vitepress-plugin-llms'

const rawBase = process.env.VITEPRESS_BASE
const base = rawBase
  ? rawBase.startsWith('/')
    ? rawBase.endsWith('/') ? rawBase : `${rawBase}/`
    : `/${rawBase}/`
  : '/'

export default withMermaid(defineConfig({
  base,
  title: 'Kimi CLI Docs',
  description: 'Kimi CLI Documentation',

  locales: {
    zh: {
      label: '简体中文',
      lang: 'zh-CN',
      link: '/zh/',
      title: 'Kimi CLI 文档',
      description: 'Kimi CLI 用户文档',
      themeConfig: {
        nav: [
          { text: '指南', link: '/zh/guides/getting-started', activeMatch: '/zh/guides/' },
          { text: '定制化', link: '/zh/customization/mcp', activeMatch: '/zh/customization/' },
          { text: '配置', link: '/zh/configuration/config-files', activeMatch: '/zh/configuration/' },
          { text: '参考手册', link: '/zh/reference/kimi-command', activeMatch: '/zh/reference/' },
          { text: '常见问题', link: '/zh/faq' },
          { text: '发布说明', link: '/zh/release-notes/changelog', activeMatch: '/zh/release-notes/' },
        ],
        sidebar: {
          '/zh/guides/': [
            {
              text: '指南',
              items: [
                { text: '开始使用', link: '/zh/guides/getting-started' },
                { text: '常见使用案例', link: '/zh/guides/use-cases' },
                { text: '交互与输入', link: '/zh/guides/interaction' },
                { text: '会话与上下文', link: '/zh/guides/sessions' },
                { text: '在 IDE 中使用', link: '/zh/guides/ides' },
                { text: '集成到工具', link: '/zh/guides/integrations' },
              ],
            },
          ],
          '/zh/customization/': [
            {
              text: '定制化',
              items: [
                { text: 'Model Context Protocol', link: '/zh/customization/mcp' },
                { text: 'Agent Skills', link: '/zh/customization/skills' },
                { text: 'Agent 与子 Agent', link: '/zh/customization/agents' },
                { text: 'Print 模式', link: '/zh/customization/print-mode' },
                { text: 'Wire 模式', link: '/zh/customization/wire-mode' },
              ],
            },
          ],
          '/zh/configuration/': [
            {
              text: '配置',
              items: [
                { text: '配置文件', link: '/zh/configuration/config-files' },
                { text: '平台与模型', link: '/zh/configuration/providers' },
                { text: '配置覆盖', link: '/zh/configuration/overrides' },
                { text: '环境变量', link: '/zh/configuration/env-vars' },
                { text: '数据路径', link: '/zh/configuration/data-locations' },
              ],
            },
          ],
          '/zh/reference/': [
            {
              text: '参考手册',
              items: [
                { text: 'kimi 命令', link: '/zh/reference/kimi-command' },
                { text: 'kimi info 子命令', link: '/zh/reference/kimi-info' },
                { text: 'kimi acp 子命令', link: '/zh/reference/kimi-acp' },
                { text: 'kimi mcp 子命令', link: '/zh/reference/kimi-mcp' },
                { text: 'kimi term 子命令', link: '/zh/reference/kimi-term' },
                { text: '斜杠命令', link: '/zh/reference/slash-commands' },
                { text: '键盘快捷键', link: '/zh/reference/keyboard' },
              ],
            },
          ],
          '/zh/release-notes/': [
            {
              text: '发布说明',
              items: [
                { text: '变更记录', link: '/zh/release-notes/changelog' },
                { text: '破坏性变更与迁移说明', link: '/zh/release-notes/breaking-changes' },
              ],
            },
          ],
        },
      },
    },
    en: {
      label: 'English',
      lang: 'en-US',
      link: '/en/',
      title: 'Kimi CLI Docs',
      description: 'Kimi CLI User Documentation',
      themeConfig: {
        nav: [
          { text: 'Guides', link: '/en/guides/getting-started', activeMatch: '/en/guides/' },
          { text: 'Customization', link: '/en/customization/mcp', activeMatch: '/en/customization/' },
          { text: 'Configuration', link: '/en/configuration/config-files', activeMatch: '/en/configuration/' },
          { text: 'Reference', link: '/en/reference/kimi-command', activeMatch: '/en/reference/' },
          { text: 'FAQ', link: '/en/faq' },
          { text: 'Release Notes', link: '/en/release-notes/changelog', activeMatch: '/en/release-notes/' },
        ],
        sidebar: {
          '/en/guides/': [
            {
              text: 'Guides',
              items: [
                { text: 'Getting Started', link: '/en/guides/getting-started' },
                { text: 'Common Use Cases', link: '/en/guides/use-cases' },
                { text: 'Interaction and Input', link: '/en/guides/interaction' },
                { text: 'Sessions and Context', link: '/en/guides/sessions' },
                { text: 'Using in IDEs', link: '/en/guides/ides' },
                { text: 'Integrations with Tools', link: '/en/guides/integrations' },
              ],
            },
          ],
          '/en/customization/': [
            {
              text: 'Customization',
              items: [
                { text: 'Model Context Protocol', link: '/en/customization/mcp' },
                { text: 'Agent Skills', link: '/en/customization/skills' },
                { text: 'Agents and Subagents', link: '/en/customization/agents' },
                { text: 'Print Mode', link: '/en/customization/print-mode' },
                { text: 'Wire Mode', link: '/en/customization/wire-mode' },
              ],
            },
          ],
          '/en/configuration/': [
            {
              text: 'Configuration',
              items: [
                { text: 'Config Files', link: '/en/configuration/config-files' },
                { text: 'Providers and Models', link: '/en/configuration/providers' },
                { text: 'Config Overrides', link: '/en/configuration/overrides' },
                { text: 'Environment Variables', link: '/en/configuration/env-vars' },
                { text: 'Data Locations', link: '/en/configuration/data-locations' },
              ],
            },
          ],
          '/en/reference/': [
            {
              text: 'Reference',
              items: [
                { text: 'kimi Command', link: '/en/reference/kimi-command' },
                { text: 'kimi info Subcommand', link: '/en/reference/kimi-info' },
                { text: 'kimi acp Subcommand', link: '/en/reference/kimi-acp' },
                { text: 'kimi mcp Subcommand', link: '/en/reference/kimi-mcp' },
                { text: 'kimi term Subcommand', link: '/en/reference/kimi-term' },
                { text: 'Slash Commands', link: '/en/reference/slash-commands' },
                { text: 'Keyboard Shortcuts', link: '/en/reference/keyboard' },
              ],
            },
          ],
          '/en/release-notes/': [
            {
              text: 'Release Notes',
              items: [
                { text: 'Changelog', link: '/en/release-notes/changelog' },
                { text: 'Breaking Changes and Migration', link: '/en/release-notes/breaking-changes' },
              ],
            },
          ],
        },
      },
    },
  },

  themeConfig: {
    outline: [2, 3],
    search: { provider: 'local' },
    socialLinks: [
      { icon: 'github', link: 'https://github.com/MoonshotAI/kimi-cli' },
    ],
  },

  vite: {
    plugins: [llmstxt()],
  },
}))
