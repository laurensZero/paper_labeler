# 剩余大修计划（第二轮）

前置：标注状态机 / 导入流水线 / 设置与云加固已完成；pytest 161、vitest 125、vue-tsc 通过。
本地表已修：`papers.updated_at` 回填、`uq_papers_filename` 唯一索引。

## 范围

| 阶段 | 主题 | 痛点 | 优先级 |
|------|------|------|--------|
| R1 | 导出流水线 | `export.ts` 巨型 store，筛选缓存/命名/裁剪/组卷导出耦合 | 高 |
| R2 | Filter 预设与缓存 | localStorage 散落，和设置快照重叠；虚拟列表缓存易脏 | 中 |
| R3 | 数据边界文档 + 组卷一致性 | 本地组卷 ≠ 云端组卷；web/ 个人数据表易误改 | 中 |
| R4 | （可选）UI 冒烟 | 状态机无 e2e，手势/双击保存靠人测 | 低 |

---

## R1 导出流水线

### 现状问题
- `stores/export.ts` 同时管：筛选 ID 缓存、命名模板、导出序列号、并发裁剪、另存目录、进度。
- 与 `filter.ts` 的 `cache:exportFilterIds*` 双向耦合，版本失效逻辑分散。
- 失败重试/部分成功语义不清。

### 设计
```
ExportPipeline (纯逻辑)
  inputs:  question_ids, options{nameTemplate, prefix/suffix, sectionStyle, cropWorkers, includeAnswers…}
  stages:  resolve → plan_pages → crop_boxes → compose_pdf/zip → report
  events:  {stage, done, total, error?}

export store: 只保留 UI 态（options、进度、lastError）+ 调 pipeline
filter cache: 迁到 utils/exportCache.ts，单一版本键
```

### 切入文件
| 文件 | 动作 |
|------|------|
| `frontend-vite/src/utils/exportPipeline.ts` | 新建纯流水线 + 测试 |
| `stores/export.ts` | 瘦身为 options/进度 |
| `stores/filter.ts` | 导出缓存调用迁出 |
| `ExportWizard.vue` / `RandomExport.vue` | 消费进度事件 |
| 测试 | 命名模板、缓存版本失效、并发裁剪上限 |

### 验收
- 导出中途失败可见、可重试，不留下半成品目录
- 筛选缓存失效只在一个地方
- 命名模板单测覆盖占位符

---

## R2 Filter 预设与缓存

### 现状问题
- `setting:filterPresets`、`setting:filterPageSize`、`cache:exportFilterIds*`、`virtualHeights` 分散。
- 设置快照已收录部分 key，但 filter 运行时缓存策略未统一。

### 设计
1. 所有 filter 持久化走 `utils/storage.ts`（或 `stores/settings` 白名单）。
2. 运行时缓存（virtualHeights、exportFilterIds）显式标 `cache:` 且可一键清。
3. 设置快照 **不含** 纯缓存，只含用户预设。

### 验收
- 导出/导入设置不带上万条缓存
- 清缓存不影响预设

---

## R3 数据边界文档 + 组卷一致性

### 现状问题
- 本地 `compositions`（整型 id）与云端 `compositions`（uuid，网页端）设计上不互通，但无文档。
- `web/` 的 `question_user_data` 个人收藏/备注与标注端全局 `is_favorite/notes` 并存。
- `section_group_members.section_name` 全局唯一 = 一个模块只能进一个组（可能是故意，需写明）。

### 设计
1. `docs/data-model.md`：本地 SQLite ↔ Supabase 字段对照、谁写谁读、不同步项清单。
2. 在设置页/组卷页加简短提示（「本机组卷不会同步到云端」）。
3. 若产品要求本地组卷上云：另开 R5（映射表 local_id→uuid），默认不做。

### 验收
- 新人看文档能判断「改这张表会不会影响网页端」
- 组卷 UI 有一句边界说明

---

## R4 UI 冒烟（可选）

- Playwright/脚本：打开标注 → 画框 → 保存 → 下一题；双击保存断言只一次请求。
- 仅在用户继续报“卡住/存两次”时投入。

---

## 实施顺序

1. **R1 导出流水线**（用户最常踩，逻辑最重）
2. **R2 Filter 存储统一**（顺手，和 R1 有缓存交集）
3. **R3 文档与边界**（半天级）
4. **R4 按需**

## 明确不做
- 不把本地组卷硬同步到云端（除非你明确要求）
- 不改 `frontend/` 旧版
- 不降页图分辨率
- 不做双向云合并

## 风险
- 导出触碰 PDF 裁剪/排版：改完必须用真实试卷抽查版式
- filter 缓存迁移：保留旧 key 读一回合，避免升级后筛选变空
