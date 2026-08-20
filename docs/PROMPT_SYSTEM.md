# Prompt 系统全面优化设计

> 适用代码库:deepcode(Claude Code 风格 TypeScript TUI 编码 agent)
> 状态:设计 + Phase A 已实现(配置化 prompt 增强 + harness 度量/质量门禁/评估 runner)
> 原则:**一切 prompt 修改保持 cache-prefix 稳定**(系统前缀无时间戳等易变内容),加性、配置可逆。

---

## 0. 现状盘点(已有机制,勿重复建设)

| 机制 | 位置 | 状态 |
|---|---|---|
| 分段式 system prompt(cache-prefix 稳定) | `src/agent/system-prompt.ts` | 已有 |
| 自动上下文压缩(折叠+摘要+裁剪 tool_result) | `src/agent/compressor.ts` | 已有 |
| token 估算 / 截断(gpt-tokenizer) | `src/agent/token-budget.ts` | 已有 |
| 输出长度上限(max_tokens,按模型钳制) | `src/agent/loop.ts:56-62` | 已有 |
| turn 预算 / 硬性兜底 / 并行工具执行 | `src/agent/loop.ts` + `config.agent` | 已有 |
| 子代理编排 / 任务委托(轮数换空间) | `src/agent/subagent.ts` + 系统提示词 Orchestrator 段 | 已有 |
| 记忆注入(Agent Memory top-k) | `src/engine.ts` + 系统提示词 ④ 段 | 已有 |
| trace 录制 / 回放 / 断言 | `src/trace/{recorder,replay,assert}.ts` | 已有(上一轮) |

本设计只补**缺口**,不重写上述机制。

---

## 1. Token 优化(压缩输入输出)

### 现状与差距
- 已有:压缩器、max_tokens 上限、tool_result 裁剪、工具只列名字不列 schema。
- 差距:(a) 无**输出风格预算**(模型可能长篇大论);(b) tool_result 裁剪阈值固定,不可按任务调;(c) 无**响应字符软上限**;(d) few-shot 与输出契约混在静态文本里,不可配置。

### 设计方案
1. **输出预算三件套**(`config.prompt`):
   - `outputStyle: 'concise' | 'balanced' | 'detailed'` → 注入输出契约的紧凑度指令(仅措辞差异,零 token 成本)。
   - `maxResponseChars: N`(0=关闭)→ 注入"每条 assistant 文本回复 ≤ N 字符"软约束。
   - 结构化为 `# Goal / ## Context / ## Constraints / ## Output / ## Example`,机器可解析,人类可阅读。
2. **tool_result 分层裁剪**(扩展 `clipToolResults`):按 tool 类型分级——`read_file` 保留行号上下文、`bash` 只留尾部 N 行、`browser_review` 压缩 base64 之外的结构。阈值来自 `config.context.maxToolResultChars`(新键)。
3. **缓存友好**:所有新增提示词均为静态文本(无时间戳/路径拼接),保持前缀命中率。工具 schema 依旧只走 `tools` 字段,不重复进 system prompt。

### 实现要点
- `src/config/types.ts`:`PromptConfig` 接口 + `DeepcodeConfig.prompt` + zod schema。
- `src/config/defaults.ts`:`defaultConfig().prompt`(concise / 0 / [] / true / true)。
- `src/agent/system-prompt.ts`:输出契约段按 `outputStyle` 渲染措辞;`maxResponseChars>0` 时追加一行。
- `src/agent/compressor.ts`:`CompressorOptions` 增加 `maxToolResultChars` 已存在 → 改为 `toolResultCaps: Record<string, number>` 可选。
- `src/cli/config.ts`:`init` 模板补 `prompt` 段示例。

### 验收标准
- `buildSystemPrompt` 对同一输入两次输出字节级相同(缓存稳定)。
- `outputStyle: 'concise'` 的提示词比 `'detailed'` 短 ≥15%。
- 压缩后 `tokensAfter/tokensBefore ≤ 0.7`(现有用例保持通过)。

---

## 2. 轮数优化(减少多轮交互)

### 现状与差距
- 已有:turn 预算、并行工具、Orchestrator 并行子代理、错误 3 次即停。
- 差距:(a) **终止条件不显式**——模型不知道"何时可以结束、何时必须结束";(b) 模型常以确认性提问结束一轮(多耗一轮);(c) 独立子任务没有在**首轮**被识别并并行分派。

### 设计方案
1. **显式完成协议(Completion Protocol)**,作为系统提示词独立章节:
   - 任务达成 → 立即以 `turn-end` 风格收尾,输出 `# Done` + 变更清单 + 验证结果;**不要**为已明确的任务再发确认问题。
   - 被阻塞(权限拒绝/重复失败/信息不足) → 输出 `# Blocked` + 原因,结束本轮。
   - 明确"什么不算完成":依赖未验证的命令输出、lint/test 未跑、截图未看。
2. **首轮预置约束**:用户输入进入 agent 前,engine 层做轻量**指令归一化**(`normalizeUserPrompt`):补全缺失的边界(工作区路径、禁止触碰的目录、验收标准),一次注入,避免第二轮补问。
3. **并行度度量驱动调优**:trace 指标新增 `maxParallelTools`(在飞工具峰值),`eval` 报告里暴露,低于期望值时调 `config.agent.maxParallelTools` 与系统提示词并行指令。

### 实现要点
- `src/agent/system-prompt.ts`:新增 `# Completion protocol` 章节(`config.prompt.completionProtocol` 控制)。
- `src/agent/prompt-utils.ts`(新):`normalizeUserPrompt(input, workspace)` 纯函数——补边界、去冗余问句。
- `src/agent/loop.ts`:`runAgentTurn` 入口调用 normalize(可选,`config.prompt.normalizeInput` 控制)。
- `src/trace/metrics.ts`:计算 `maxParallelTools`。

### 验收标准
- 完成协议开启后,同任务 trace 的 `turns` 不增(回归测试用 fixture 断言)。
- `normalizeUserPrompt` 为纯函数、有单测(不展开成多轮)。

---

## 3. Prompt 增强(指令质量)

### 现状与差距
- 已有:角色设定、plan mode 契约、项目约定、记忆、技能目录、工具用法规则。
- 差距:(a) 无 few-shot 示例;(b) 结构化输出契约只有"要求",没有"样例";(c) 规则分散,模型优先级不明确。

### 设计方案
1. **规则优先级排序**:系统提示词各章节按序排列(角色 → 项目约定 → 工具规则 → 输出契约 → 安全),并在头部加一行"冲突时按章节顺序后者覆盖前者"。
2. **Few-shot 示例注入**(`config.prompt.examples: string[]`):每个示例用统一模板 `## Example` + 任务/约束/输出三行;默认内置 1 个紧凑的结构化输出示例(约 60 token),用户可替换为领域示例。
3. **输出契约模板化**:固定 `# Goal / ## Context / ## Input contract / ## Output contract / ## Constraints / ## Example` 骨架,模型按骨架填,便于后续做结构化解析(配合维度 5 校验)。

### 实现要点
- `src/agent/system-prompt.ts`:输出契约段改为模板化 + `examples` 拼接;头部加优先级声明。
- `src/config/types.ts`:`PromptConfig.examples: string[]`(schema `z.array(z.string()).max(5)`)。
- `tests/system-prompt.test.ts`(新):断言章节顺序、优先级行、example 注入与禁用。

### 验收标准
- `prompt.examples=[]` 时输出契约无 example 段(默认零成本)。
- 章节顺序固定,顺序变更需改测试(防止无意破坏缓存前缀稳定性)。

---

## 4. 命中率优化(结果准确度)

### 现状与差距
- 已有:计划模式只读、错误自纠指令、"不要编造输出"。
- 差距:(a) 无**完成前验证契约**——模型可能不跑测试就宣称完成;(b) 无确定性语言约束(模糊词汇);(c) 无"验证失败→自纠"的显式回路。

### 设计方案
1. **验证契约(Verify-on-done)**:完成协议内嵌——
   - 改动代码 → 必须跑相关 build/lint/test 并**引用真实输出**;
   - 前端改动 → 必须 `browser_review` 截图确认;
   - 输出中禁止"大概/应该没问题"类模糊措辞,必须给确定性结论;
   - 验证失败 → 读取错误、自纠、重验,**不得**直接宣告完成。
2. **确定性语言约束**:输出契约追加"结论必须可被命令复现;引用真实路径与真实输出"。
3. **校验回路工具化**(依赖维度 5):trace 的 `tool-result.isError` 与 `stopReason` 进入质量门禁,验证不足的回合在 eval 中被标记,反馈注入重试。

### 实现要点
- `src/agent/system-prompt.ts`:完成协议/输出契约加入验证条款(`config.prompt.verifyOnDone`)。
- `src/trace/quality.ts`:质量分含"验证充分性"代理指标(修改类任务未伴随 test/lint 工具调用 → 扣分)。

### 验收标准
- `verifyOnDone: true` 时,修改类任务 trace 中 test/lint 调用率提升(人工抽查 3 个任务)。
- 质量报告能指出"改代码但未验证"的 trace(单测覆盖判定逻辑)。

---

## 5. Harness 增强(自动化评估/回归)

> 在 `src/trace/*`(recorder/replay/assert)之上补齐:可观测性 → 多策略回退 → 质量阈值 → 自反馈迭代。

### 5.1 可观测性 — `src/trace/metrics.ts`(已实现)

从一份 trace 派生结构化指标(离线、毫秒级):

```ts
interface TraceMetrics {
  turns: number; durationMs: number;
  toolCalls: number; toolFailures: number; toolSuccessRate: number;
  maxParallelTools: number;            // 在飞工具峰值(维度 2 的并行度证据)
  approvals: number; errors: number;
  tokensIn: number; tokensOut: number; cacheReadTokens: number; costUsd: number;
  settled: boolean;                     // 维度 4 的 UI 状态回归哨兵
  stopReason?: string; compacted: number; delegated: number;
}
```

来源映射:turn-start/`session` 时间戳→turns/duration;tool-start/`tool-result(isError)`→调用与失败;usage 事件→tokens/cost;approval-request→approvals;error→errors;compacted/delegated 事件;replayState→settled。并行度用 tool-start/tool-result 栈模拟。

### 5.2 质量阈值评估 — `src/trace/quality.ts`(已实现)

- 阈值来自 `config.prompt.quality`:`minToolSuccessRate / maxTurns / maxTokensPerTask / requireSettled`。
- 输出 `QualityReport { metrics, passed, failures[], score }`:加权评分(默认权重:settled 25、工具成功率 25、turns 20、tokens 15、errors 15),0-100。
- `assessQuality(metrics, thresholds)` 为纯函数,单测覆盖。

### 5.3 多策略回退 — `src/trace/eval.ts`(已实现,骨架)

评估任务执行失败的**三档回退**,不依赖重跑即重跑:

1. **确定性回退**:失败断言 → 先用 `replay` 复现 UI 状态(零成本)定位是"状态问题"还是"模型问题";
2. **脚本化回退**:模型级失败 → 以 scripted provider(固定脚本)重放同一任务,隔离环境/模型差异;
3. **真实重跑回退**:仍失败 → 带质量报告作为反馈 hint 重跑(`maxRetriesOnFail` 限制),见 5.4。

### 5.4 自反馈迭代 — `src/trace/eval.ts` 的 retry 回路

```
runEval(task):
  attempt = 0
  while attempt <= maxRetriesOnFail:
    trace = runTask(task, feedbackHint)     # hint 追加到 prompt 尾部
    report = assessQuality(metrics(trace))
    if report.passed: 记录 trace + report → corpus; return
    if attempt == maxRetriesOnFail: 标记 FAIL; return
    feedbackHint = "上一轮质量门禁失败:<failures>;请针对性修正后重试"
    attempt += 1
```

- 成功路径:每次重试的 trace 都进 corpus(可观测);失败路径:report 落 `FAIL` 文件。
- Baseline 对比:任务执行前读 `baseline/<taskId>.json`,分数下降超过阈值 → 报回归。

### 5.5 接入点(已实现)

- CLI:`deepcode eval [tasksDir]`(默认 `traces/tasks`),头less 模式,每任务独立 engine + recorder。
- 任务套件格式 `traces/tasks/<id>.json`:

```json
{ "id": "fix-lint", "prompt": "修复 src/a.ts 的 lint 错误", "budget": { "maxTurns": 15 } }
```

- 单元测试用 `runTask` 依赖注入(不碰真实 API);`runEval` 纯逻辑可测。

### 验收标准
- `metricsFromTrace` 在 400 事件 trace 上 <10ms。
- `assessQuality` 对已知好坏 trace 给出正确 pass/fail。
- 质量失败时 retry 回路注入 hint、次数受 `maxRetriesOnFail` 限制,且全部 attempt 均有 trace 落盘。

---

## 6. 落地路线图

| Phase | 内容 | 状态 |
|---|---|---|
| A | `config.prompt` + system prompt 加性章节(1-4 维) | ✅ 已实现 |
| B | trace metrics + quality 门禁(5.1/5.2) | ✅ 已实现 |
| C | eval runner + 自反馈重试 + CLI `eval`(5.3/5.4/5.5) | ✅ 已实现 |
| D | tool_result 按类型分级裁剪、normalizeUserPrompt 接入 loop | 待做 |
| E | baseline 仓库 + CI 每日 eval 报告 | 待做 |

每阶段验收:typecheck 通过、全量 vitest 通过、`build` 成功(本机需 `NODE_OPTIONS="" npm run build`)。
