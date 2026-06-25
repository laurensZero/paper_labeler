# 组卷模式 (Compose Mode) — 设计计划书

## 概述

新增「组卷模式」，让用户从题库中自由挑选题目，按需排序、添加空白页、配置试卷头信息，实时预览最终试卷效果，并可保存方案供后续编辑和重复导出。

## 核心决策

| 维度 | 决策 |
|------|------|
| 存储 | 后端 SQLite，新增 `compositions` + `composition_items` 表 |
| 路由 | `/compose` 独立页面，`/compose/:id` 编辑已有方案 |
| 入口 | 顶部导航栏「组卷」+ 侧边栏底部方案列表 |
| 布局 | 三栏：左侧题库筛选、中间实时预览、右侧属性/统计面板 |
| 预览 | 图片堆叠，一页一题，黑色边框（复用现有 PDF 渲染逻辑），模拟最终 PDF |
| 排序 | Section 分组模式 + 自由拖拽模式，可切换 |
| 空白页 | 每题可设默认空白页数 + 任意位置自由插入 |
| 答案控制 | 全局总开关（开/关），不含逐题覆盖 |
| 标题/页眉 | 支持试卷标题、页眉页脚文字 |
| 分值 | 不实现，数据模型预留 `score` 字段 |
| 元数据 | 方案名称，后续可扩展考试标题、时长等 |

---

## 数据模型

### 新增表：`compositions`

```sql
CREATE TABLE compositions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        VARCHAR NOT NULL,               -- 方案名称，如 "2024年模拟卷"
    title       VARCHAR,                        -- 试卷标题（显示在 PDF 顶部）
    header_text VARCHAR,                        -- 页眉文字
    footer_text VARCHAR,                        -- 页脚文字
    include_answers  BOOLEAN NOT NULL DEFAULT 0, -- 全局答案开关
    answers_placement VARCHAR NOT NULL DEFAULT 'end', -- end / interleaved
    group_by_section BOOLEAN NOT NULL DEFAULT 1, -- 是否按 section 分组
    show_section_headers BOOLEAN NOT NULL DEFAULT 1, -- 显示 section 标题
    show_question_info BOOLEAN NOT NULL DEFAULT 1,  -- 显示题目来源信息
    show_page_numbers  BOOLEAN NOT NULL DEFAULT 1,  -- 显示页码
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

### 新增表：`composition_items`

```sql
CREATE TABLE composition_items (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    composition_id  INTEGER NOT NULL REFERENCES compositions(id) ON DELETE CASCADE,
    question_id     INTEGER NOT NULL REFERENCES questions(id),
    sort_order      INTEGER NOT NULL DEFAULT 0,  -- 排序序号
    blank_pages     INTEGER NOT NULL DEFAULT 0,  -- 该题后追加的空白页数
    item_type       VARCHAR NOT NULL DEFAULT 'question',  -- 'question' | 'blank_page'
    score           REAL,                         -- 预留：分值
    custom_header   VARCHAR,                      -- 预留：自定义题目头
    created_at      DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_comp_items_composition ON composition_items(composition_id, sort_order);
CREATE INDEX idx_comp_items_question ON composition_items(question_id);
```

### SQLAlchemy ORM

```python
class Composition(Base):
    __tablename__ = "compositions"
    id = Column(Integer, primary_key=True, index=True)
    name = Column(String, nullable=False)
    title = Column(String, nullable=True)
    header_text = Column(String, nullable=True)
    footer_text = Column(String, nullable=True)
    include_answers = Column(Boolean, nullable=False, default=False)
    answers_placement = Column(String, nullable=False, default="end")
    group_by_section = Column(Boolean, nullable=False, default=True)
    show_section_headers = Column(Boolean, nullable=False, default=True)
    show_question_info = Column(Boolean, nullable=False, default=True)
    show_page_numbers = Column(Boolean, nullable=False, default=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)


class CompositionItem(Base):
    __tablename__ = "composition_items"
    id = Column(Integer, primary_key=True, index=True)
    composition_id = Column(Integer, ForeignKey("compositions.id", ondelete="CASCADE"), nullable=False, index=True)
    question_id = Column(Integer, ForeignKey("questions.id"), nullable=False, index=True)
    sort_order = Column(Integer, nullable=False, default=0)
    blank_pages = Column(Integer, nullable=False, default=0)
    item_type = Column(String, nullable=False, default="question")
    score = Column(Float, nullable=True)
    custom_header = Column(String, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)
```

### TypeScript 类型

```typescript
// types/composition.ts

export interface Composition {
  id: number
  name: string
  title: string | null
  header_text: string | null
  footer_text: string | null
  include_answers: boolean
  answers_placement: 'end' | 'interleaved'
  group_by_section: boolean
  show_section_headers: boolean
  show_question_info: boolean
  show_page_numbers: boolean
  created_at: string
  updated_at: string
}

export interface CompositionItem {
  id: number
  composition_id: number
  question_id: number
  sort_order: number
  blank_pages: number
  item_type: 'question' | 'blank_page'
  score: number | null
  custom_header: string | null
}

export interface CompositionDetail extends Composition {
  items: CompositionItemDetail[]
}

export interface CompositionItemDetail extends CompositionItem {
  question_no: string | null
  sections: string[]
  paper_exam_code: string | null
  preview_image_url: string | null
}

export interface CompositionCreateParams {
  name: string
  title?: string
  header_text?: string
  footer_text?: string
  include_answers?: boolean
  answers_placement?: 'end' | 'interleaved'
  group_by_section?: boolean
  show_section_headers?: boolean
  show_question_info?: boolean
  show_page_numbers?: boolean
}

export interface CompositionUpdateParams extends Partial<CompositionCreateParams> {}

export interface CompositionItemAddParams {
  question_id: number
  sort_order?: number
  blank_pages?: number
  item_type?: 'question' | 'blank_page'
}

export interface CompositionItemUpdateParams {
  sort_order?: number
  blank_pages?: number
  custom_header?: string
}

export interface CompositionReorderParams {
  item_ids: number[]  // 按新顺序排列的 item id 列表
}
```

---

## API 设计

### 组卷方案 CRUD

| 方法 | 路径 | 说明 |
|------|------|------|
| `POST` | `/compositions` | 创建方案 |
| `GET` | `/compositions` | 列表（含 item count） |
| `GET` | `/compositions/{id}` | 详情（含 items 及题目信息） |
| `PATCH` | `/compositions/{id}` | 更新方案元数据 |
| `DELETE` | `/compositions/{id}` | 删除方案（级联删除 items） |
| `POST` | `/compositions/{id}/duplicate` | 复制方案 |

### 组卷条目操作

| 方法 | 路径 | 说明 |
|------|------|------|
| `POST` | `/compositions/{id}/items` | 添加题目（支持批量） |
| `DELETE` | `/compositions/{id}/items/{item_id}` | 移除单个条目 |
| `PATCH` | `/compositions/{id}/items/{item_id}` | 更新条目（空白页数等） |
| `POST` | `/compositions/{id}/items/reorder` | 批量排序 |
| `POST` | `/compositions/{id}/items/batch` | 批量操作（添加/移除多个） |

### 导出

| 方法 | 路径 | 说明 |
|------|------|------|
| `POST` | `/compositions/{id}/export` | 从方案创建导出 job（复用现有 export pipeline） |

---

## 前端架构

### 路由

```typescript
// router/index.ts 新增
{ path: '/compose', name: 'compose', component: () => import('@/views/ComposeView.vue') },
{ path: '/compose/:id', name: 'compose-edit', component: () => import('@/views/ComposeView.vue') },
```

### Pinia Store: `compose.ts`

```
useComposeStore
├── compositions: Composition[]           -- 方案列表
├── current: CompositionDetail | null     -- 当前编辑的方案
├── items: CompositionItemDetail[]        -- 当前方案的条目（排序后）
├── dirty: boolean                        -- 是否有未保存的修改
├── previewMode: 'grouped' | 'free'       -- 排序模式
├── selectedItemId: number | null         -- 当前选中的条目
│
├── loadCompositions()                    -- 加载方案列表
├── loadComposition(id)                   -- 加载方案详情
├── createComposition(params)             -- 创建方案
├── updateComposition(params)             -- 更新方案元数据
├── deleteComposition(id)                 -- 删除方案
├── duplicateComposition(id)              -- 复制方案
│
├── addQuestion(questionId)               -- 添加题目到方案
├── removeItem(itemId)                    -- 移除条目
├── updateItemBlankPages(itemId, pages)   -- 设置空白页数
├── insertBlankPage(afterItemId)          -- 在指定位置插入空白页
├── reorderItems(itemIds)                 -- 重新排序
│
├── toggleAnswers()                       -- 切换全局答案开关
├── setAnswersPlacement(placement)        -- 设置答案位置
│
├── exportComposition()                   -- 导出 PDF（调用现有 export pipeline）
└── saveComposition()                     -- 保存方案到后端
```

### ComposeView.vue 布局

```
┌──────────────────────────────────────────────────────────────────┐
│  [📋 组卷]  方案名: [________]  [保存] [导出PDF]    [方案列表 ▾]  │
├────────────┬────────────────────────────────┬────────────────────┤
│ 题库面板    │     实时预览区                  │  属性面板          │
│            │                                │                    │
│ [筛选器]   │  ┌─ Section A ───────────────┐  │  当前选中:         │
│ Section ▾  │  │ Q1. [crop image]          │  │  Q12 - 2023/m    │
│ Year    ▾  │  │ Source: xxx  [blank: 0 ▾] │  │  Sections: [...]  │
│ Paper   ▾  │  ├──────────────────────────┤  │                    │
│            │  │ Q3. [crop image]          │  │  空白页: [0] [+1] │
│ ┌────────┐ │  │ Source: xxx  [blank: 2 ▾] │  │  [移除] [原卷定位] │
│ │ Q1  ✓  │ │  │                           │  │                    │
│ │ Q2     │ │  │ ┌─ (空白页) ─────────────┐ │  │  ─── 试卷设置 ─── │
│ │ Q3  ✓  │ │  │ │                        │ │  │  标题: [________] │
│ │ Q4     │ │  │ └────────────────────────┘ │  │  答案: [开/关]    │
│ │ Q5     │ │  ├──────────────────────────┤  │  答案位置: [尾部]  │
│ │ ...    │ │  │ ┌─ (空白页) ─────────────┐ │  │  分组: [Section]  │
│ └────────┘ │  │ │                        │ │  │                    │
│            │  │ └────────────────────────┘ │  │  ─── 统计 ────    │
│ 点击添加→  │  └────────────────────────────┘  │  总题数: 5        │
│            │                                │  空白页: 3        │
│            │  排序模式: [分组] [自由]         │  预估页数: ~8     │
│            │  底部缩略图: [Q1][Q3][Q5]...    │                    │
├────────────┴────────────────────────────────┴────────────────────┤
│  状态栏                                                          │
└──────────────────────────────────────────────────────────────────┘
```

### 组件拆分

| 组件 | 说明 |
|------|------|
| `ComposeView.vue` | 页面主容器，三栏布局 |
| `ComposeToolbar.vue` | 顶部工具栏（方案名、保存、导出、方案切换） |
| `ComposeQuestionPanel.vue` | 左侧题库筛选 + 题目列表（复用 FilterView 的筛选逻辑） |
| `ComposePreview.vue` | 中间实时预览区（图片堆叠渲染） |
| `ComposePreviewItem.vue` | 单个题目预览卡片（crop 图 + 信息 + 空白页控制） |
| `ComposeBlankPage.vue` | 空白页占位组件 |
| `ComposeProperties.vue` | 右侧属性面板（选中题目的详情 + 试卷全局设置） |
| `ComposeStats.vue` | 统计信息（题数、空白页数、预估页数） |
| `ComposeThumbnailStrip.vue` | 底部缩略图条（拖拽排序） |
| `ComposeListModal.vue` | 方案列表弹窗（选择/管理已有方案） |

### 侧边栏集成

在 `Sidebar.vue` 的 footer 区域，`sections` 按钮之前，新增一个「组卷」按钮：

```html
<button class="footer-btn" @click="router.push({ name: 'compose' })">
  <svg>...</svg>
  <span>组卷</span>
</button>
```

同时在 Sidebar 的 PaperList 下方增加一个可折叠的「组卷方案」区域，列出最近的方案，点击直接进入编辑。

---

## 预览渲染逻辑

### 核心思路

预览区模拟最终 PDF 的渲染，但用 HTML/CSS 实现（不生成临时 PDF）：

1. **每题一页**：每个 question item 渲染为一个固定高度的容器（模拟 A4 比例）
2. **黑色边框**：复用现有 PDF 的 `rect` 逻辑，CSS `border: 2px solid black`
3. **crop 图片**：直接使用现有的 `preview_image_url`
4. **空白页**：固定高度的空白容器，带虚线边框标识
5. **section 分隔**：当 `group_by_section` 开启时，插入 section 标题条
6. **信息头**：每题顶部显示题号、section、来源等（可配置）

### CSS 模拟

```css
.compose-page {
  width: 210mm;           /* A4 宽度 */
  min-height: 297mm;      /* A4 高度 */
  background: white;
  box-shadow: 0 2px 8px rgba(0,0,0,0.15);
  margin: 16px auto;
  padding: 15mm;
  position: relative;
}

.compose-question-frame {
  border: 2px solid #000;
  padding: 4px;
}

.compose-blank-page {
  border: 2px dashed #ccc;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #ccc;
  font-style: italic;
}

.compose-section-header {
  background: #f0f0f0;
  padding: 8px 16px;
  font-weight: bold;
  font-size: 14px;
  border-bottom: 2px solid #333;
}
```

---

## 空白页实现

### 两种空白页

1. **题目附属空白页**：每道题可以设置「追加 N 页空白」，跟随题目移动
   - 在 `ComposePreviewItem` 下方渲染 N 个 `ComposeBlankPage`
   - 数据存储在 `composition_items.blank_pages`

2. **独立空白页**：在任意位置插入的自由空白页
   - 数据存储为 `item_type = 'blank_page'` 的独立 `composition_item`
   - 在预览中渲染为 `ComposeBlankPage`
   - 可以像题目一样拖拽排序

### 添加空白页的交互

- 题目详情面板：「空白页」输入框 + 增减按钮
- 预览区：题目之间有一个 `+` 按钮，点击插入独立空白页
- 缩略图条：右键菜单「在此之后插入空白页」

---

## 排序模式

### Section 分组模式（默认）

- 题目按第一个 section 自动分组排列
- 组内可以拖拽调整顺序
- 显示 section 分隔标题
- 新添加的题目自动归入对应 section 组

### 自由拖拽模式

- 关闭分组，所有题目平铺
- 完全自由拖拽排序
- 不显示 section 分隔

### 切换逻辑

- 切换到分组模式：按 section 重新排序，组内保持原相对顺序
- 切换到自由模式：保持当前顺序不变
- 切换时提示用户「将重新排列题目顺序」

---

## 与现有导出 Pipeline 的集成

### 导出流程

1. 用户点击「导出 PDF」
2. 前端收集方案中的题目 ID 列表（按 sort_order 排序）
3. 构建导出选项，映射到现有 `ExportOptions` 格式
4. 调用 `POST /compositions/{id}/export`（后端内部调用现有 `_make_pdf` 逻辑）
5. 复用现有的 job 队列、进度轮询、下载机制

### 需要扩展的导出选项

现有的 `_make_pdf` 需要支持：

- `title`：试卷标题（显示在第一页顶部）
- `header_text` / `footer_text`：页眉页脚
- `blank_pages`：每题后的空白页数（逐题配置）
- `section_headers`：section 分隔页
- 保持现有 `include_answers`、`answers_placement` 等选项

### 后端扩展方案

在 `ExportOptions` 中新增字段：

```python
class ExportOptions(BaseModel):
    # ... 现有字段 ...
    title: Optional[str] = None                    # 试卷标题
    header_text: Optional[str] = None              # 页眉
    footer_text: Optional[str] = None              # 页脚
    blank_pages_per_question: Optional[List[int]] = None  # 每题对应空白页数
    section_headers: Optional[List[str]] = None    # section 分隔信息
    show_section_headers: bool = False
```

---

## 实现阶段

### Phase 1: 后端数据层

**目标**：数据库表 + CRUD API

- [ ] `database.py`：新增 `Composition` 和 `CompositionItem` ORM 模型
- [ ] `init_db()`：添加表创建 + migration 逻辑
- [ ] `schemas/schemas.py`：新增 Composition 相关 Pydantic schemas
- [ ] `routers/compositions.py`：新增 CRUD 路由
  - `POST /compositions` — 创建
  - `GET /compositions` — 列表
  - `GET /compositions/{id}` — 详情（join 题目信息）
  - `PATCH /compositions/{id}` — 更新
  - `DELETE /compositions/{id}` — 删除
  - `POST /compositions/{id}/duplicate` — 复制
  - `POST /compositions/{id}/items` — 添加条目（批量）
  - `DELETE /compositions/{id}/items/{item_id}` — 删除条目
  - `PATCH /compositions/{id}/items/{item_id}` — 更新条目
  - `POST /compositions/{id}/items/reorder` — 排序
- [ ] `main.py`：注册新 router

### Phase 2: 前端类型 + Store

**目标**：TypeScript 类型 + Pinia store

- [ ] `types/composition.ts`：类型定义
- [ ] `types/index.ts`：导出新类型
- [ ] `api/endpoints.ts`：API 函数封装
- [ ] `stores/compose.ts`：Pinia store（完整 CRUD + 排序逻辑）

### Phase 3: 基础 UI — 方案管理

**目标**：能创建/选择/管理方案

- [ ] `ComposeView.vue`：页面骨架（三栏布局）
- [ ] `ComposeToolbar.vue`：工具栏（方案名、保存、导出）
- [ ] `ComposeListModal.vue`：方案列表弹窗
- [ ] `router/index.ts`：添加路由
- [ ] `Sidebar.vue`：添加组卷入口按钮

### Phase 4: 题库面板 + 添加题目

**目标**：能从题库筛选并添加题目到方案

- [ ] `ComposeQuestionPanel.vue`：左侧题库面板
  - 复用 FilterView 的筛选逻辑（section/year/season/paper）
  - 题目列表，点击添加/移除（toggle）
  - 已添加的题目显示 ✓ 标记

### Phase 5: 预览区 + 空白页

**目标**：实时预览试卷效果

- [ ] `ComposePreview.vue`：预览区容器
- [ ] `ComposePreviewItem.vue`：单题预览卡片
- [ ] `ComposeBlankPage.vue`：空白页组件
- [ ] `ComposeThumbnailStrip.vue`：底部缩略图条 + 拖拽排序
- [ ] 实现两种空白页（附属 + 独立）
- [ ] Section 分组显示

### Phase 6: 属性面板 + 试卷设置

**目标**：右侧属性面板和全局设置

- [ ] `ComposeProperties.vue`：属性面板
  - 选中题目的详情显示
  - 空白页数调整
  - 移除/定位操作
- [ ] `ComposeStats.vue`：统计信息
- [ ] 试卷全局设置（标题、答案开关、分组模式等）

### Phase 7: 导出集成

**目标**：从方案导出 PDF

- [ ] 后端：扩展 `ExportOptions` 支持 title/header/footer/blank_pages
- [ ] 后端：`POST /compositions/{id}/export` 端点
- [ ] 后端：`_make_pdf` 扩展支持空白页、section 分隔页、试卷标题
- [ ] 前端：`composeStore.exportComposition()` 调用导出
- [ ] 前端：复用现有 ExportWizard 的 job 进度 UI

### Phase 8: 拖拽排序 + 交互打磨

**目标**：拖拽排序和交互优化

- [ ] 集成拖拽库（`vuedraggable` 或 `@vueuse/integrations` 的 `useSortable`）
- [ ] 缩略图条拖拽排序
- [ ] 预览区内拖拽排序
- [ ] 排序模式切换（分组 ↔ 自由）
- [ ] 键盘快捷键（Delete 移除、Ctrl+S 保存）
- [ ] 侧边栏方案列表（折叠区域）

### Phase 9: 收尾

- [ ] i18n：新增中文/英文翻译
- [ ] 响应式布局适配
- [ ] 错误处理和边界情况
- [ ] 性能优化（大量题目时的虚拟滚动）

---

## 关键文件清单

### 新增文件

| 文件 | 说明 |
|------|------|
| `backend/routers/compositions.py` | 组卷方案 API |
| `frontend-vite/src/types/composition.ts` | TypeScript 类型 |
| `frontend-vite/src/stores/compose.ts` | Pinia store |
| `frontend-vite/src/views/ComposeView.vue` | 主页面 |
| `frontend-vite/src/components/compose/ComposeToolbar.vue` | 工具栏 |
| `frontend-vite/src/components/compose/ComposeQuestionPanel.vue` | 题库面板 |
| `frontend-vite/src/components/compose/ComposePreview.vue` | 预览区 |
| `frontend-vite/src/components/compose/ComposePreviewItem.vue` | 题目预览卡片 |
| `frontend-vite/src/components/compose/ComposeBlankPage.vue` | 空白页 |
| `frontend-vite/src/components/compose/ComposeProperties.vue` | 属性面板 |
| `frontend-vite/src/components/compose/ComposeStats.vue` | 统计 |
| `frontend-vite/src/components/compose/ComposeThumbnailStrip.vue` | 缩略图条 |
| `frontend-vite/src/components/compose/ComposeListModal.vue` | 方案列表 |

### 需修改的现有文件

| 文件 | 修改内容 |
|------|---------|
| `backend/database.py` | 新增 Composition, CompositionItem 模型 |
| `backend/main.py` | 注册 compositions router |
| `backend/schemas/schemas.py` | 新增 Composition schemas |
| `backend/routers/export.py` | ExportOptions 扩展 + _make_pdf 支持空白页/标题 |
| `frontend-vite/src/router/index.ts` | 新增 /compose 路由 |
| `frontend-vite/src/types/index.ts` | 导出 composition 类型 |
| `frontend-vite/src/api/endpoints.ts` | 新增 API 函数 |
| `frontend-vite/src/components/Sidebar.vue` | 添加组卷入口 |
| `frontend-vite/src/components/layout/TitleBar.vue` | 导航栏添加「组卷」 |
| `frontend-vite/src/i18n/zh-CN.json` | 新增翻译 |
| `frontend-vite/src/i18n/en.json` | 新增翻译 |

---

## 风险和注意事项

1. **大量题目的预览性能**：如果方案包含 50+ 题目，预览区可能卡顿
   - 方案：虚拟滚动 / 分页预览 / 仅渲染可视区域

2. **拖拽排序的 UX**：拖拽库的选择影响体验
   - 推荐：`vuedraggable`（基于 Sortable.js，成熟稳定）

3. **导出时的空白页渲染**：fpdf 的空白页逻辑需要仔细对齐
   - 每题后的空白页用 `add_page()` 实现
   - 独立空白页作为 `item_type='blank_page'` 也需要渲染

4. **方案与题目的关联**：题目被删除时，方案中的引用需要处理
   - 后端：`ON DELETE CASCADE` 或 soft delete
   - 前端：加载方案时过滤掉已失效的 item

5. **并发编辑**：多个浏览器标签同时编辑同一方案
   - 初期不做处理，后端用 `updated_at` 做简单冲突检测
