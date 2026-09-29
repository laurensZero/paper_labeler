# web 端「试卷下载」功能设计方案

## 目标

在云端网页端 `web/` 新增 **试卷下载** 页：按科目 / 年份 / 考季筛选 CIE 真题，好看地浏览 QP / MS / ER / GT，支持单份下载与多选打包 ZIP。数据源与标注端一致：`cie.fraft.cn`。

不在范围：导入题库 / OCR / 组卷导出；不改 `frontend-vite/` 与旧 `frontend/`。

---

## 1. 视觉方向（Design Pass）

### 风格锚点

**Apple Education 资源中心 × Linear 产品列表**——学院气、克制、高信息密度但不挤。不是营销落地页，而是同事每天会点开的资源台。

### 色板（沿用 web 设计 token，再加类型色）

| 角色 | 值 | 用途 |
|------|-----|------|
| 背景 | `#f5f5f7` | 页面底 |
| 卡片 | `#ffffff` | 浮起表面 |
| 墨色 | `#141416` | 主文字 |
| 次级 | `#5f6570` | 说明、文件名 |
| 弱化 | `#8e8e93` | 占位、辅助 |
| 主强调 | `#2070c0` | 按钮、选中、链接 |
| 主强调 hover | `#1a5ea8` | |
| QP 类型 | `#2070c0` / soft `rgba(32,112,192,.12)` | 试卷 |
| MS 类型 | `#2f6b4f` / soft `#dcebe3` | 评分方案 |
| ER 类型 | `#8a6d1f` / soft `#f3ecd4` | 考官报告 |
| GT 类型 | `#6b5b8a` / soft `#ebe6f4` | 分数线 |
| 线 | `#e4e4e8` | 分割 |

### 字体

- 正文/标题：`"SF Pro Display", "PingFang SC", "Microsoft YaHei", …`（与 `web/src/styles.css` 一致）
- 文件名：同上，`font-variant-numeric: tabular-nums`；字重 500
- 标题尺度：页标题 28px/700，区块 15px/600，卡片标题 14px/600，正文 13px，辅助 12px

### 布局

- 顶栏复用现有 `topbar`，导航加「试卷下载」
- 内容最大宽 `1120px`，左右 `24px` 边距
- **筛选栏** sticky top：科目（可搜）、年份、考季 chips、检索框；一行放不下则两行，圆角 12
- **结果区**：按 Paper 号分组（Paper 1 / 2 / …），组头左侧大号 Paper 标签，右侧 variant 徽章；组内 QP/MS 成对卡片横排；ER/GT 独立「全卷附件」区
- 卡片：文件名 + 类型徽章 + Paper/Variant + 下载按钮；多选 checkbox 悬浮显示
- 多选时底部浮出 **工具条**（已选 N 项 · 清空 · 打包 ZIP）
- 密度：卡片间距 12px，组间距 28px；一页结果可滚动，筛选栏不随内容滚走

### 签名瞬间

1. **类型徽章配色**——扫一眼就知道 QP/MS/ER/GT
2. **QP ↔ MS 成对胶囊**——同一 Paper 的题卷与评分方案视觉锁在一起，减少找错版本
3. **下载反馈**——按钮内联进度（转圈 → 对勾），ZIP 时工具条进度条；成功 toast 右上轻入

空态：居中简洁插画位（线性图标即可）+「调整筛选试试」。

---

## 2. 架构

```text
浏览器 (web/)
  │  supabase-js functions.invoke / fetch + JWT
  ▼
Supabase Edge Function  cie-papers
  │  HTTPS 服务端代理（绕过 CORS、统一鉴权、可设 Content-Disposition）
  ▼
cie.fraft.cn
  POST /obj/Common/Subject/combo
  POST /obj/Common/Fetch/renum
  GET  /obj/Common/Fetch/redir/{filename}
```

### 为什么用 Edge Function

- `web/` 现状是纯 Supabase（auth + Postgres + R2 图），没有 FastAPI
- 列表接口是 POST 表单，浏览器直连会 CORS 失败
- PDF 虽可用 `<a>` 跨域打开，但无法设 `attachment` 文件名；ZIP 打包必须服务端拉流

### 端点设计（`supabase/functions/cie-papers/`）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/subjects` | 代理 subject_combo，带磁盘/内存缓存 24h（Edge 用 Cache API） |
| GET | `/papers?subject=&year=&season=` | 代理 renum，解析出结构化列表 |
| GET | `/file/{filename}` | 流式转发 PDF，`Content-Disposition: attachment; filename*=UTF-8''...` |
| POST | `/zip` | body: `{ filenames: string[] }`（≤30），服务端下载并 zip 流式返回 |

鉴权：`Authorization: Bearer <supabase_jwt>`；未登录 401（与 web 其它页一致）。  
安全：`filename` 白名单正则 `^[A-Za-z0-9]+_(?:[smw]\d{2}|)(?:_|-)?.*\.pdf$`，并校验路径仅透传到 redir，防 SSRF。

### 解析规则（前端共用）

文件名：`{subject}_{s|m|w}{yy}_{qp|ms|er|gt}_{paper}{variant}.pdf` 或 `{subject}_{s|m|w}{yy}_{er|gt}.pdf`

| 字段 | 含义 |
|------|------|
| season `s/m/w` | Jun / Mar / Nov |
| type `qp/ms/er/gt` | 试卷 / 评分方案 / 考官报告 / 分数线 |
| `qp_12` | Paper 1, Variant 2 |
| `er` / `gt` | 该考季全卷附件，无 paper 号 |

列表返回规范化结构，避免前端各自正则：

```ts
type PaperFile = {
  filename: string
  url: string          // 代理下载地址
  type: 'qp' | 'ms' | 'er' | 'gt'
  paper: number | null // 1..n
  variant: number | null
  label: string        // "Paper 1 · Variant 2" | "Examiner Report"
}
```

---

## 3. 前端信息架构

### 导航

`App.vue` nav 增加 `试卷下载` → 路由 `/download`（登录后可用，与 bank/compose 同级）。

### 页面结构 `DownloadView.vue`

1. **页头**：标题「试卷下载」+ 副文案「CIE 历年真题与评分资料 · 即选即下」+ 来源徽章 `cie.fraft.cn`
2. **筛选栏**（sticky）
   - 科目：搜索式 Select（选项来自 `/subjects`，显示 `9709 - 数学…`）
   - 年份：下拉 2015–2026 + 快捷 chips「近三年」
   - 考季：`3 月 / 6 月 / 11 月` 分段控件
   - 类型过滤：全部 / 仅 QP / 仅 MS / 附件（多选 chips）
3. **结果**
   - 加载骨架（组头 + 卡片灰块）
   - 按 Paper 分组；组内 QP、MS 并排；无 MS 时该位显示「暂无评分方案」
   - ER/GT 在「全卷附件」横向卡片
   - 顶栏统计：`共 38 份 · 已选 0`
4. **卡片交互**
   - hover 提升阴影 + checkbox 浮现
   - 单载按钮：`下载`
   - 整组快捷：「下本 Paper 全部」（QP+该 variants 的 MS）
5. **多选工具条**（fixed bottom）：计数、清空、**打包下载 ZIP**、逐个下载
6. **状态**：空结果 / 接口失败（可重试）/ 下载失败 toast / 配额说明（若与 export 共用周限则提示，否则不限）

### i18n

`zh-CN.json` / `en.json` 增加 `download.*` 命名空间；导航 `app.nav.download`。

---

## 4. 代码改动清单

| 路径 | 动作 |
|------|------|
| `supabase/functions/cie-papers/index.ts` | 新建：代理 + PDF 流 + ZIP |
| `supabase/functions/cie-papers/cie.ts` | 新建：上游请求与解析（可单测） |
| `web/src/views/DownloadView.vue` | 新建：主界面 |
| `web/src/lib/cieDownload.ts` | 新建：API client、filename 解析、分组、触发下载 |
| `web/src/components/PaperDownloadCard.vue` | 新建：单文件卡片 |
| `web/src/router/index.ts` | 注册 `/download` |
| `web/src/App.vue` | 导航项 |
| `web/src/i18n/zh-CN.json` / `en.json` | 文案 |
| `web/src/styles.css` | 仅加 download 作用域样式（或 SFC scoped，优先 scoped 少碰全局） |

不改：`backend/routers/cie_import.py`（标注端专用）、`frontend-vite/`、`frontend/`。

---

## 5. 实施步骤

1. **Edge Function**  
   实现 `subjects` / `papers` / `file` / `zip`；filename 白名单；错误映射为 JSON `{ error }`。  
   本地 `supabase functions serve cie-papers` 用真实上游联调。
2. **lib 解析与 API**  
   `cieDownload.ts`：调 functions、解析文件名、按 paper 分组、`downloadBlob` 触发保存（复用 `pdfExport.ts` 的 blob 模式）。
3. **DownloadView UI**  
   按设计稿搭筛选 + 分组列表 + 多选工具条 + toast；骨架/空态/错误态。
4. **接线**  
   路由、导航、i18n；登录守卫（现有 `router.beforeEach` 已覆盖）。
5. **ZIP 多选**  
   工具条 → `POST /zip` → 下载 `{subject}_{season}{yy}.zip`；限制 30 份并提示。
6. **自检**  
   - `web` 下 `npm run build` / `vue-tsc`  
   - 浏览器走通：登录 → 选 9709 / 2023 / 6月 → 列出 qp/ms/er/gt → 单下、多选 ZIP  
   - 移动宽度 375 不横向溢出  
   - 未登录跳登录；非法 filename 返回 400

---

## 6. 验收标准

- [ ] 顶栏可进入「试卷下载」
- [ ] 科目/年份/考季筛选可用，结果按 Paper 分组，QP/MS 配对清晰
- [ ] 单文件下载文件名正确（浏览器保存名 = CIE 文件名）
- [ ] 多选打包 ZIP ≤30 份成功
- [ ] 视觉符合上述设计：类型色、sticky 筛选、浮出工具条、骨架/空态
- [ ] 不改标注端 `frontend-vite` / 旧 `frontend` / `backend` 导入链路

---

## 7. 风险与对策

| 风险 | 对策 |
|------|------|
| cie.fraft.cn 限流或挂掉 | subjects 走缓存；错误态给「稍后重试」；不在前端散落直连 |
| 上游无 CORS/会话 cookie | 全部经 Edge，不暴露给浏览器 |
| ZIP 内存 | 逐文件 stream append，上限 30；超时 60s |
| 文件名非规范 | 解析失败时仍可下载，类型徽章显示「其它」 |
| Supabase Functions 部署权限 | 提供 `supabase functions deploy cie-papers`；JWT 用现有 anon + 用户 session |
