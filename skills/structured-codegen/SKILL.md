---
name: structured-codegen
description: Structured code generation: clarify the input/output contract and acceptance criteria before the task (especially beneficial for general-purpose models)
---

# Structured Code Generation

When the user asks to "implement/generate/refactor code", follow this fixed structure in your output (write it at the start of your first reply or use it as the execution plan):

# Goal
(One sentence stating what needs to be done)

## Input Contract
(Describe which inputs will be used: existing code, interfaces, data formats)

## Output Contract
(Describe the deliverables: file list, language/version, exported interfaces, how to run)

## Constraints
- (Tech stack/style/performance/compatibility limits)

## Acceptance Criteria
- (Verifiable completion conditions: build passes, test cases, behavior checklist)

Execution order: list the contracts first → get confirmation or implement directly per the contract → verify each completed item against the acceptance criteria.
