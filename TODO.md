# 翻译待办事项

## 概述
已翻译 12 个可视化组件。还剩以下文件的硬编码英文字符串需要翻译。

---

## 1. constants.ts — VERSION_META 翻译
**路径**: `web/src/constants.ts`

12 个 VERSION_META 条目的 `title`、`subtitle`、`coreAddition`、`keyInsight` 字段需翻译为中文。

---

## 2. step-controls.tsx — 按钮 tooltip 翻译
**路径**: `web/src/components/visualizations/shared/step-controls.tsx`

需要翻译的字符串：
- `"Reset"` → `"重置"`
- `"Previous step"` → `"上一步"`
- `"Next step"` → `"下一步"`
- `"Auto-play"` → `"自动播放"`
- `"Pause"` → `"暂停"`
- `"Play"` → `"播放"`

---

## 3. agent-loop-simulator.tsx — 空状态文本
**路径**: `web/src/components/simulator/agent-loop-simulator.tsx`

需要翻译的字符串：
- `"Press Play or Step to begin"` → `"按播放或单步开始"`
- 可能还有其他硬编码的英文状态文本

---

## 4. simulator-controls.tsx — 检查是否遗漏
**路径**: `web/src/components/simulator/simulator-controls.tsx`

检查是否有遗漏的硬编码英文字符串（部分使用了 i18n，需确认是否完整）

---

## 执行顺序建议
1. 先做 `step-controls.tsx`（最小改动）
2. 再做 `agent-loop-simulator.tsx`
3. 最后做 `constants.ts`（12 个条目，工作量最大）
