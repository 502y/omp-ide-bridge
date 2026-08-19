# OMP IDE Bridge

[English](README.md) | [简体中文](README.zh-CN.md)

> [!CAUTION]
> **本项目目前是一个纯 Vibe Coding 项目。** 项目的代码、测试、文档和视觉资源，
> 均在人工提出目标并验收的前提下，由 AI 编程代理生成和迭代。项目虽然已经通过自动化检查，
> 但尚未接受独立的人工代码审查或安全审计；用于生产环境前，请务必自行仔细审查。

> 这是 [Oh My Pi](https://github.com/can1357/oh-my-pi) 的非官方社区集成。
> 本项目与 Oh My Pi 维护者无从属关系，也未获得其背书。

为 OMP 编程代理提供实时 IDE 集成：代理会在每轮对话中自动获知**你打开了哪些文件、
选中了什么内容，以及语言服务器报告了哪些问题**。

## 安装

### 从插件市场安装 IDE 端

如果希望一键安装 IDE 端插件，请先从对应市场安装：

- [Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=502y.omp-ide-bridge)：
  适用于 VS Code、Cursor、Windsurf 及其他 VS Code 兼容编辑器。
- [JetBrains Marketplace](https://plugins.jetbrains.com/plugin/33610)：
  适用于 IntelliJ IDEA、PyCharm、WebStorm、GoLand、Rider、CLion 及其他
  IntelliJ Platform IDE（2023.1+）。

### OMP 端

从公开仓库安装：

```sh
omp plugin install github:502y/omp-ide-bridge
```

如需测试本地检出的版本：

```sh
omp plugin install /absolute/path/to/omp-ide-bridge
```

### 从源码安装 VS Code / Cursor / Windsurf

```sh
cd packages/vscode-extension
npm ci
npm run typecheck && npm run compile && npm run smoke
npx @vscode/vsce package
code --install-extension omp-ide-bridge-*.vsix
```

同一个 VSIX 可以用于所有 VS Code 衍生编辑器。新建的集成终端会自动注入
`OMP_IDE_PORT`；较早打开的终端则通过锁文件扫描和工作区匹配完成发现。

### JetBrains（IDEA、PyCharm、WebStorm、GoLand、Rider、CLion 等）

```sh
cd packages/jetbrains-plugin
./gradlew buildPlugin
./gradlew verifyPlugin
# 设置 → 插件 → ⚙ → 从磁盘安装插件 → build/distributions/*.zip
```

仓库内置的 Gradle Wrapper 使用 JDK 17。兼容性已针对 IntelliJ IDEA Community
2023.1.7 和 2024.3.1 进行验证。只能在真实 IDE 中完成的检查记录在
`packages/jetbrains-plugin/DEV-NOTE.md`。

```text
┌─────────────────────────┐          ┌──────────────────────────┐
│  IDE (server)           │          │  OMP terminal (client)   │
│  vscode-extension /     │  ws://   │  packages/omp-extension  │
│  jetbrains-plugin       │ ◀──────▶ │                          │
│  WS server 127.0.0.1    │ JSON-RPC │  · injects <ide-context> │
│  writes ~/.omp/ide/     │          │    before every turn     │
│  <port>.lock            │          │  · ide_* tools, /ide cmd │
└─────────────────────────┘          └──────────────────────────┘
```

通信协议见 [docs/protocol.md](docs/protocol.md)。各包职责如下：

| 包 | 职责 | 状态 |
|---|---|---|
| `packages/omp-extension` | OMP 侧客户端、上下文注入和工具 | TypeScript 检查 + 27 项 Bun 集成测试 |
| `packages/vscode-extension` | VS Code / Cursor / Windsurf / VSCodium 服务端 | TypeScript 检查 + 跨平台 smoke 测试 |
| `packages/jetbrains-plugin` | IntelliJ Platform 服务端（IDEA、PyCharm 等） | `buildPlugin` + IC 2023.1.7 和 2024.3.1 插件验证器检查 |

## 工作原理

1. IDE 插件在 `127.0.0.1` 的随机端口（10000–65535）启动 WebSocket 服务，
   并写入 `~/.omp/ide/<port>.lock`。锁文件包含进程 PID、工作区目录、IDE 名称和
   每个窗口独立生成的 `authToken`。POSIX 系统将目录权限设为 `0700`、文件权限设为
   `0600`；Windows 则依赖当前用户 Profile 的 ACL。
2. OMP 在会话启动时扫描该目录，优先选择工作区包含代理当前目录的 IDE；新建集成终端
   也可以通过 `$OMP_IDE_PORT` 精确指定端口。连接时，认证令牌通过
   `x-omp-ide-authorization` WebSocket 升级请求头发送。
3. 每轮代理执行前，扩展会注入一条隐藏消息：

   ```text
   <ide-context source="VS Code">
   Active file: src/foo.ts (selection lines 12-34)
   <selection language="ts">…</selection>
   Open tabs: a.ts, src/b.ts
   Diagnostics: 2 errors, 1 warning
   - src/foo.ts:12:5 error …
   </ide-context>
   ```

   重复上下文会被去重；内容没有变化时不会重复消耗 token。
4. IDE 主动推送 `selection_changed`、`editors_changed` 和 `diagnostics_changed`
   通知；OMP 经过防抖后按需拉取诊断信息。
5. 在 IDE 中选中代码并执行 **“OMP: Mention Selection”**，会通过
   `at_mentioned` 将该片段加入下一轮对话。

## 在 OMP 中使用

- 直接对话：代理会在每轮自动看到当前文件和选区。
- `/ide`：查看连接状态和发现的 IDE；`/ide 2`：连接第 2 个 IDE；`/ide off`：断开连接。
- 连接后模型可以调用：`ide_get_editor_context`、`ide_open_file`、
  `ide_get_diagnostics`、`ide_save_document` 和 `ide_open_diff`。
  `ide_open_diff` 仅由 VS Code 插件支持，并会等待用户接受或拒绝修改。

## 开发

环境要求：Node.js 22+、Bun 1.3.14+ 和 JDK 17。

```sh
cd packages/vscode-extension
npm ci && npm run typecheck && npm run compile && npm run smoke

cd ../omp-extension
bun install --frozen-lockfile && bunx tsc --noEmit && bun test

cd ../jetbrains-plugin
./gradlew buildPlugin verifyPlugin
```

CI 会在 Windows、macOS 和 Linux 上运行 TypeScript 相关检查，并在 Linux 上验证
JetBrains 插件。

## 安全与隐私

- 服务端只监听 `127.0.0.1`。
- 每个 IDE 窗口都会生成随机认证令牌。
- WebSocket 入站消息大小限制为 16 MiB。
- 本仓库没有实现遥测或外部网络请求。
- 选中文本和诊断信息只会发送给本地运行的 OMP 进程；之后，OMP 配置的模型提供商可能会
  将其作为代理上下文接收。
- `executeCode` 被有意设为不支持。

漏洞报告方式和威胁模型详见 [SECURITY.md](SECURITY.md)。

## 设计源流

本项目的架构借鉴了终端模式 IDE Bridge：IDE 作为回环 WebSocket 服务端，通过锁文件
完成发现，并使用带认证的 JSON-RPC 通信。它是面向 OMP 的独立社区实现，使用自己的
命名空间：`~/.omp/ide/`、`OMP_IDE_PORT` 和 `x-omp-ide-authorization`。

项目采用 [MIT License](LICENSE) 许可证。
