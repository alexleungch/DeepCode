# TUI 界面审计报告（deepcode）

> 审计范围：`src/ui/**`（Ink 6 / React 19 终端 TUI）+ `src/cli.ts`（生命周期）+ `src/agent/at-refs.ts`（@file）。
> 结构：问题描述 → 改进建议 → 预期收益，按 4 维度组织，标注优先级（高/中/低）。
> 状态：**高/中优先级 10 项已在 Batch 1 实施**（见"实施状态"列）；低优先级项待按序推进。

## 优先级汇总

| 优先级 | 数量 | 状态 |
|---|---|---|
| 高 | 5 | ✅ Batch 1 已实施 |
| 中 | 5 | ✅ Batch 1 已实施 |
| 低 | 8 | ⏳ 延后（本文档含建议，待决定） |

---

## 维度 1：布局与视觉层次

### #4 ToolCard 头部固定截断，窄终端强制换行 【中 · ✅ 已实施】
- **问题**：`friendlySummary` 内部按固定 80/60 字符截断（ToolCard.tsx L131-168），与终端 `width` 无关；头部 `pad = Math.max(1, …)`（L261）无法收缩到内容以下，窄终端（宽度下限 `max(40, cols-4)`）下头部溢出为第二行。
- **改进**：`friendlySummary(tc, maxColumns = 80)` 增加列宽参数，头部渲染按可用宽度（扣除图标/名称/时长/边框）计算 `summaryMax` 并整体截断（复用 CJK 安全的 `clipByWidth`）。默认参数保持旧行为，既有精确断言不破。
- **预期收益**：任意窗口宽度下工具卡片保持单行头部，布局稳定；中文路径截断不再超宽。

### #9 标题层级无区分 【中 · ✅ 已实施】
- **问题**：h1/h2/h3 全部渲染为 `theme.primary` 粗体（MessageList.tsx L41-47），长回复中标题无法快速定位结构。
- **改进**：`buildMarkdownLines` 按 kind 映射 —— h1 = 粗体 primary、h2 = primary（非粗）、h3 = 粗体 assistant。
- **预期收益**：视觉层级可辨，长文扫读更快；不改变行数估计（行高不变）。

### #11 引用块丢失标记 【低 · ⏳ 延后】
- **问题**：`renderMarkdown` 的 `quote` 行去掉了 `>`（markdown.ts L209-212），渲染后与正文完全一致，引用语义丢失。
- **改进**：渲染时加 `│ ` 前缀（保留 segments）。
- **预期收益**：引用内容可辨识。
- **实现思路**：`MessageList.buildMarkdownLines` 对 `l.kind === 'quote'` 输出 `'│ ' + l.text`，indent 0。

### #12 分隔线固定 40 字符 【低 · ⏳ 延后】
- **问题**：`markdownToPlain` 中 hr 为 `'─'.repeat(40)`（markdown.ts L258），<42 列终端溢出。
- **改进**：按可用宽度截断。
- **预期收益**：窄屏不溢出。

### #13 dimColor 在浅色主题下对比度不足 【低 · ⏳ 延后】
- **问题**：ToolCard 时长（L276）、TodoPanel 已完成项（L38）、ApprovalDialog 提示（L73/77）用 Ink `dimColor`（终端默认前景降亮度），浅色主题下可读性偏低且非主题可控。
- **改进**：改为显式 `color={theme.muted}`（浅色主题 muted 为深灰，对比度 ≥4.8:1）。
- **预期收益**：浅色/深色主题下时长等次要信息一致可读。

### #14 无视觉滚动条 【低 · ⏳ 延后】
- **问题**：原 scrollbar 被"↓ Back to bottom (End) · N msgs above · P%"文字提示取代（app.tsx L472-475，位于 StatusBar 第二行），长对话中缺少位置感。
- **改进**：视口右侧渲染 1 列迷你滚动条（thumb 比例 = mainAreaRows / totalRows），或保留文字提示并增强百分比。
- **预期收益**：快速感知阅读位置。
- **实现思路**：`virtual-scroll` 已提供 totalRows/firstVisibleRow，在消息容器右缘加一个 `flexShrink: 0` 的 `Box` 渲染 `█`/`░` 列。

---

## 维度 2：交互与响应

### #1 Home/End 双绑定冲突 【高 · ✅ 已实施】
- **问题**：普通 Home/End 在 app.tsx（L306-313，滚动历史到顶/底）与 PromptInput（L186-193，光标到行首/尾）**同时绑定**；Ink 会触发所有 useInput handler，导致按下 Home/End 既滚动历史又移动光标。
- **改进**：app.tsx 仅响应 `Ctrl+Home`/`Ctrl+End`（历史跳转）；PromptInput 普通 Home/End 专管光标（`!key.ctrl` 门控）。/help 已同步标注新语义。
- **预期收益**：按键行为确定无歧义；输入框内 Home/End 正常编辑，历史跳转用 Ctrl+Home/End。

### #5 /help 快捷键文档缺失 【高 · ✅ 已实施】
- **问题**：/help 只列了部分命令与 4 个快捷键（ESC/Shift+Tab/Shift+↑↓/PageUp），遗漏 Ctrl+O/Ctrl+C、Ctrl+A/E/U/K/W、Tab 补全、Alt+Enter、@file 用法。
- **改进**：重写为"Available commands + Keybindings + @file references"三节。
- **预期收益**：可发现性大幅提升，无需翻源码。

### #6 tool-progress 空 callId 误刷全部卡片 【高 · ✅ 已实施】
- **问题**：`tool-progress` 空 callId 时（state.ts L261）会追加到**每一个** running 卡片——一行 bash 输出被复制到所有进行中的工具卡。
- **改进**：新增 `lastLiveCallId()`，空 callId 只追加到最近一个 live 卡片；无 live 卡片时忽略。
- **预期收益**：并行工具场景输出不再串卡。

### #7 tool-input-delta 未节流 【中 · ✅ 已实施】
- **问题**：EventBatcher 只节流 text-delta/thinking-delta/tool-progress（event-batcher.ts L17），tool-input-delta 逐 token setState（state.ts L244-252），长参数流（如大 JSON 入参）造成 jank。
- **改进**：`tool-input-delta` 加入 16ms 节流集合（EventBatcher 保序：控制事件先 flush 缓冲，顺序不变）。
- **预期收益**：流式工具参数渲染帧率稳定。

### #15 滚轮在输入框上仍滚动历史 【低 · ⏳ 延后】
- **问题**：wheel 事件（SGR 1006 带 x/y 坐标，app.tsx L316-321）未做命中测试，输入区滚轮也滚动历史。
- **改进**：解析 y 坐标，命中输入框区域时忽略。
- **预期收益**：输入多行草稿时滚轮不再误翻历史。
- **实现思路**：`parseMouse` 已返回 y（mouse.ts），比较 y ≥ rows - inputHeight 则跳过。

### #16 每个工具卡片常驻 spinner 定时器 【低 · ⏳ 延后】
- **问题**：`useSpinnerFrame` 每个组件独立 setInterval 常驻（spinner.ts L19-25），N 个卡片 = N 个永久定时器。
- **改进**：仅 `active` 时启用帧循环（已是条件参数，但 interval 未按 active 启停）；或改共享单例帧时钟。
- **预期收益**：空闲期零定时器开销。

---

## 维度 3：可读性与可用性

### #2 行内代码在浅色主题不可见 【高 · ✅ 已实施】
- **问题**：行内代码 `color={theme.code}`（MessageList.tsx L110），而 light/gruvbox-light 下 `theme.code === theme.assistant`（#1f2328/#282828）——与正文同色，完全无区分。
- **改进**：行内代码加 `backgroundColor={theme.codeBg}`（与代码块同底色，形成 chip）。
- **预期收益**：浅色主题下行内代码清晰可辨；深色主题样式统一。

### #3 clipLine 按 UTF-16 长度截断，CJK 溢出 【中 · ✅ 已实施】
- **问题**：`clipLine`（markdown.ts L267-270）按字符串长度截断，中文/全角字符占 2 列——按长度截断会多截 1+ 列（内容变短）或超宽溢出。影响 4 处：ThinkingLine、ToolCard 头部/结果行、TodoPanel、ApprovalDialog。
- **改进**：新增 `clipByWidth(text, maxColumns)`，按显示列宽逐字符截断（复用 `charWidth`，emoji 不被拆半），**保留省略号列宽、总宽永不超限**；`clipLine` 委托实现，全部调用点自动受益。
- **预期收益**：中文/emoji 路径与文本在任意宽度下不溢出、不截短；与旧 ASCII 行为完全一致（'hello world'@8 → 'hello w…' 不变）。

### #8 StatusBar 长字段不截断 【中 · ✅ 已实施】
- **问题**：StatusBar 无 `width` prop（StatusBar.tsx L48），workspace 路径与 `lastStopReason` 不截断，窄终端换行。
- **改进**：新增 `width` prop（app.tsx 传入），路径/停止原因按剩余宽度 `clipByWidth`。
- **预期收益**：窄屏状态栏保持单行。

---

## 维度 4：跨平台兼容性

### #10 OSC 11 只解析 `rgb:` 形式 【低 · ✅ 已实施】
- **问题**：`background.ts` 正则只匹配 16/24 位 `rgb:RRRR/GGGG/BBBB`，部分终端（如某些 tmux/自定义实现）以 `#RRGGBB` 应答，浅色探测失败退回默认深色主题。
- **改进**：新增 `#RRGGBB` 形式；修正 24 位解析（取每通道高字节）；导出 `osc11ToHex` 并补单测。
- **预期收益**：更多终端在浅色背景下自动启用 light 主题。

### #17 Windows conhost 不支持 1049/1006 【低 · ⏳ 延后（仅文档）】
- **问题**：传统 conhost 不支持 alternate screen（1049）与 SGR 鼠标（1006）——无全屏接管、无滚轮滚动；Windows Terminal 正常。
- **改进**：文档化此边界；代码已自然降级（功能缺失而非崩溃），可选在启动时检测并提示。
- **预期收益**：已知边界明确，用户不会被"无滚轮"惊吓。

### #18 非 TTY 环境回退路径 【低 · ⏳ 延后（保持现状）】
- **问题**：非 TTY 已回退 print 渲染器 / readline REPL（cli.ts L126-141），逻辑正确但存在与 TUI reducer 的格式化重复。
- **改进**：维持现状；如需收敛可抽公共格式化层。
- **预期收益**：降低维护成本（非紧急）。

---

## Batch 1 实施清单（已完成，含验证）

| # | 文件 | 改动 | 新增测试 |
|---|---|---|---|
| 3 | src/ui/markdown.ts | `clipByWidth`（列宽截断+预留省略号）、`clipLine` 委托 | tests/markdown.test.ts |
| 4 | src/ui/components/ToolCard.tsx | `friendlySummary(maxColumns)` 按可用宽度截断头部 | （既有精确断言回归） |
| 8 | src/ui/components/StatusBar.tsx + app.tsx | `width` prop + 路径/原因截断 | （tui-render/layout-pinned 回归） |
| 2 | src/ui/components/MessageList.tsx | 行内代码 `backgroundColor=theme.codeBg` | — |
| 9 | src/ui/components/MessageList.tsx | h1/h2/h3 层级样式 | — |
| 5 | src/ui/app.tsx | /help 三节重写（含 Keybindings + @file） | help.test.tsx 回归 |
| 1 | src/ui/app.tsx + PromptInput.tsx | Home/End 归输入框，Ctrl+Home/End 归历史滚动 | tests/prompt-input.test.tsx |
| 6 | src/ui/state.ts | tool-progress 空 callId → 仅最近 live 卡片 | tests/tui.test.ts |
| 7 | src/ui/event-batcher.ts | tool-input-delta 加入 16ms 节流 | — |
| 10 | src/ui/background.ts | `#RRGGBB` 形式 + 24 位修正 + 导出 osc11ToHex | tests/background.test.ts |

验证：`tsc --noEmit` 通过；`vitest run` 全绿（新增 3 个测试文件 / 26 项）；`tsup` 构建成功。

## 后续批次候选（按序建议）

1. #13 dimColor → theme.muted（一次性小改动，收益明确）
2. #11 引用块标记 + #12 hr 截断（同属 markdown 渲染，一起做）
3. #14 迷你滚动条（视觉增强，中等工作量）
4. #15 滚轮命中测试 + #16 spinner 定时器（交互/性能）
5. #17 conhost 文档（README 补一节）
