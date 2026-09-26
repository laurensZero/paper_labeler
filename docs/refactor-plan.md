# paper_labeler 大修计划

目标：低端机不卡、保存/删除一次到位、导入进度真实、设置可迁移、云同步可测可信。
范围：只动 `frontend-vite/` + `backend/`（`frontend/` 废弃不动）。

## 顺序与理由

| 阶段 | 内容 | 理由 |
|------|------|------|
| P1 | 标注状态机（答案 + 题目） | 直接影响正确性与卡顿，用户最痛 |
| P2 | CIE 导入流水线 | 0/6 进度假、失败不可见、耦合难测 |
| P3 | 设置与云同步 | 换机丢配置；云未测且有安全/完整性缺口 |

每阶段：抽纯逻辑 → 单入口状态机/流水线 → 补测试 → 接回 UI → 回归。

---

## P1 标注状态机（答案 + 题目）

### 问题

答案侧（`stores/answer.ts` + `AnswerView.vue`）：
- 双击保存可双重 POST；`answerNext` / `goToQuestion` / `handleSave` 并发交错
- `ensureAnswerReady` 与 `_openSeq` 双锁不同步；replace 期间可能卡 `answerOpening`
- `loadAnswerQuestion` 导航路径无 seq，旧响应可覆盖新题
- `clearAnswerBoxes` 在 replace 下静默退出，与 `saveAnswer` 判定不一致
- `answerRemovedExistingIdx` 用下标，load 重排后易失效

题目侧（`stores/mark.ts` + `MarkView.vue`，约 1000+1068 行）：
- 与 answer 同类：drawing / selected / undo / persistBusy / OCR draft 多态交织
- `markPersistBusy` 硬挡保存但无队列；删除最后一框与编辑题 ID 分支多
- 残留死字段 `answerReplaceMode/QuestionId` 与 answer store 重复
- 新建题 vs 编辑题 vs OCR 草稿 三条路径混在同一 `newBoxes` 数组

### 设计

抽 **纯状态机**（不依赖 Vue），store 只做 IO + 转发事件。

**答案机状态**
```
idle → opening → ready.clean ⇄ ready.dirty → saving → ready.clean
                              ↘ replaceReturning
idle → opening → ready.replacing.dirty → saving → replaceReturning → idle
```

**题目机状态**
```
idle → opening → ready.mode_create.clean|dirty
               → ready.mode_edit.clean|dirty
               → ready.mode_ocr.clean|dirty
             → saving → ready.*.clean | replaceReturn
```

**事件（两机共用骨架）**
`OPEN` / `LOAD` / `EDIT_*` / `SELECT` / `UNDO` / `REDO` / `SAVE` / `SAVE_OK` / `SAVE_FAIL` / `NAV` / `BACK` / `REPLACE_ENTER` / `REPLACE_EXIT` / `CLEAR`

**不变量**
1. 任一时刻至多一个手势（drawing/drag）
2. `saving` 期间拒绝 NAV/EDIT/SAVE（幂等忽略，不抛错）
3. replace 下 SAVE 成功必回 filter；普通 SAVE 成功后 +1 到未答
4. 切题前必须 flush 进度；`LOAD` 带 `seq`，过期响应丢弃
5. 软删用 **稳定 id**（或 box 引用），不用下标

### 切入文件

| 文件 | 动作 |
|------|------|
| `frontend-vite/src/utils/answerMachine.ts` | 新建，纯 FSM + 测试 |
| `frontend-vite/src/utils/markMachine.ts` | 新建，纯 FSM + 测试 |
| `stores/answer.ts` / `stores/mark.ts` | 改为事件转发；删死字段 |
| `AnswerView.vue` / `MarkView.vue` | 去掉散落 if；只发事件、绑渲染 |
| `utils/paper.ts` | 保留 helper；`buildAnswerSaveBoxes` 对齐稳定 id |
| 测试 | `answerMachine.test.ts` / `markMachine.test.ts` 覆盖竞态剧本 |

### 验收

- 双击保存只发一次请求；saving 中导航不丢编辑
- replace：改框 → 一次保存 → 回 filter，删除不复活
- 题目：新建/编辑/OCR 三模式互斥清晰，删空框可保存或按模式回退
- 低端机拖框仍用 rAF 节流（不回退）

---

## P2 导入流水线

### 问题

- `_import_pdf_from_url` 单体：download/save/render/analyze/ocr/cleanup 耦合
- `current/msg` 只计整份完成 → 并行期「0/6」假进度
- 失败只在终态汇总，中途无 per-item 错误
- 无阶段函数测试；失败回滚无测试

### 设计

```
ImportPipeline
  stages: download → register → render → analyze → ocr → finalize
  事件: { item, stage, frac, status, error? }
  权重表独立配置（download 0.30 / register 0.05 / render 0.40 / analyze 0.10 / ocr 0.15）
```

| 文件 | 动作 |
|------|------|
| `backend/services/import_pipeline.py` | 新建：阶段函数 + ImportContext + 事件回调 |
| `backend/routers/cie_import.py` | 瘦身为路由 + job 调度；`publish()` 用 `sum(item_frac)` |
| `stores/cieImport.ts` + `CieImport.vue` | 消费 per-item 状态；显示 active 列表与失败原因 |
| 测试 | mock 下载；小 PDF 渲染断言 4x/WebP q=90；进度字段；失败回滚 |

### 验收

- 并行导入时进度连续可感（不再卡在 0/N）
- 单份失败不影响其他份，失败原因可见
- 渲染分辨率/质量不变

---

## P3 设置与云同步

### 问题

- 设置散落 `localStorage` 裸写（theme/locale/setting:*/cieImport 历史/进度），换机即丢
- 云同步单向推、未同步 compositions；`/cloud/*` 零鉴权；同步状态仅内存
- `papers.source_updated_at` 用 `created_at` 语义不一致
- 用户 **尚未实测** 云同步 → 先可观测、可回滚，再扩功能

### 设计

**设置**
1. `utils/storage.ts` 为唯一读写口（迁现有 key，不改 key 名，兼容旧数据）
2. `stores/settings.ts` 聚合导出 `exportSettingsSnapshot` / `importSettingsSnapshot`
3. 设置页增加「导出设置 / 导入设置」（JSON 文件，不依赖云）
4. （可选后置）`GET/PUT /settings` 本机 JSON，为云同步预留

**云（保守单向推，先可测）**
1. `/cloud/*` 加本机 token（`PAPER_CLOUD_TOKEN`，.env）；未配置则拒绝远程写接口
2. 补 `compositions` / `composition_questions` 同步
3. 同步状态落盘 `data/cloud_sync_state.json`（last_run、计数、错误）
4. `source_updated_at` 语义修正（papers 用真实 update 时间戳列或 max(children)）
5. CloudAdmin 增加「同步日志」面板（接 `applog`）
6. `tests/test_cloud.py` 补 API 级测试（token 拒绝/通过、状态落盘）

### 验收

- 设置可导出/导入，换机恢复科目年份与偏好
- 未带 token 无法调管理接口
- 云同步失败有日志可查；重启不丢「上次同步」
- 用户可按「同步到云端」跑通一轮并核对条数

---

## 实施检查清单

- [ ] P1 答案状态机 + 测试
- [ ] P1 题目状态机 + 测试
- [ ] P1 接回 AnswerView / MarkView
- [ ] P2 导入流水线拆分 + 进度修复
- [ ] P2 前端 per-item 进度
- [ ] P3 设置统一 + 导出导入
- [ ] P3 云鉴权 / 状态落盘 / compositions / 测试
- [ ] 全量 `pytest` + `vitest` + `vue-tsc`

## 风险

- 状态机改写触碰手势绘制：必须保留 rAF/节流与手势期抑制重绘
- 导入拆阶段勿改 4x 渲染与 WebP 参数
- 云改动勿提交密钥；`.env` 保持本地
- 工作区有未提交云相关文件：分阶段干净提交，不与标注/日志混提

## 明确不做

- 不改 `frontend/` 旧版
- 不做双向云合并 / 多机 LWW（留到实测后）
- 不降页图分辨率
