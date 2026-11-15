# 云端题库数据流水线

标注端 → 云端 → OCR 识别 → 图形切分 → web 组卷消费。每批新题两条命令，无人值守。

```
标注端框题/框答案
      │  backend 同步（图片传 R2 + 元数据入云端）
      ▼
云端 questions / question_boxes / answers / answer_boxes
      │
      ├─① python ocr/run_incremental.py                  OCR 增量识别
      │     RPC pending_ocr_questions 判待办（框指纹）
      │     → Xiaomi-OCR-0 → .md → scripts/writeback_ocr.py → question_ocr
      │
      ├─② python scripts/split_figures.py --write        图形区切分
      │     同一套框指纹判定，只处理新题/框变更题
      │     → 下载框图（本地缓存）→ CV 切分 → question_figures
      │
      ▼
web LaTeX 组卷消费三张表（见下）
```

① 与 ② 相互独立，都只依赖同步落库，先跑哪个都行。

## 三张表分工（LaTeX 组卷）

| 表 | 内容 | 来源 |
|---|---|---|
| `question_ocr` | 题干文本（Markdown + LaTeX，`\(\)`/`\[\]` 已归一化为 `$`/`$$`） | OCR 回写 |
| `question_boxes` | 框裁剪图（R2 webp）+ bbox | 标注同步 |
| `question_figures` | 图形子区域 bbox（框图相对像素坐标）+ kind 元数据 | CV 切分 |

纯文本题（约 82%）不依赖任何图片；含图题组卷时才按 bbox 从框图 canvas 现场裁切
（`drawImage` 九参），**不产生也不上传任何切分图**——图形是框图的衍生数据，天然跟随。

## question_figures 字段

| 字段 | 含义 |
|---|---|
| `bbox` | `[x, y, w, h]`，框图相对像素坐标 |
| `kind` | `figure` 真图形；`table` 带框线数据表（OCR 简单表已转 Markdown，web 端去重跳过；茎叶图等空间表无 Markdown，照常按图渲染） |
| `full_box` | 图形区覆盖 >85% 框面积（整框纯图形，该框无文本） |
| `confidence` | 1.0 正常；0.6 细横条（数轴等），建议人工复核后使用 |
| `boxes_fingerprint` | 切图时的框指纹，同 0013 规则；框变更后重跑自动刷新 |

## 算法（scripts/split_figures.py，确定性 CV，无 ML）

1. Otsu 二值化 → 连通域分析
2. 行高 H 由真实笔画（面积 >200）高度中位数标定；图形 CC =
   高 > 2.2H 且宽 > 2.5H（曲线/三角形/扇形等组合图形），或宽 > max(6H, 0.3w)
   （轴线/表格框线/数轴；0.3w 下限排除分数杠、根号上划线；2.5H 排除大 Σ/∫ 符号）
3. 正文行保护：字符按垂直重叠聚带，带内 ≥3 字符且横向跨度 ≥500px 判为正文行，
   永不被图形区吸收
4. 图形区 = 图形 CC 聚类 bbox，迭代吸收邻近非正文字符（轴标 y=f(x)/O/π）；
   一框多图按垂直间隙 > 2.5H 拆分
5. kind 判定：表格横竖线相交成单个网格连通域，逐 CC 数线无效，
   改数区域内通宽横墨带（数据表 3~11 条且含竖带；≥12 条为作图网格纸，仍按图）

## 命令

```bash
# OCR 增量（题库更新后）
python ocr/run_incremental.py

# 图形切分（dry-run 出蒙太奇，确认后加 --write）
python scripts/split_figures.py --write          # 全量（增量按指纹跳过）
python scripts/split_figures.py --only-flagged   # 只跑启发式含图候选
python scripts/split_figures.py --force          # 忽略指纹全量重算
python scripts/split_figures.py --montage-only   # 仅从 results.json 重出蒙太奇
```

审查产物在 `ocr/figures_review/`（蒙太奇 sheets + results.json，/ocr/ 已 gitignore）。
蒙太奇每项标注 `q{qid} b{box_id}#{ord}`，TBL=表格、FULL=整框、c0.6=低置信。

## 幂等与增量

- 框指纹 = `page:box_id:content_hash`（同 0013/0014 RPC 规则）。框重裁/补删框后
  指纹变化，①② 重跑即自动重做该题，无需人工对账。
- 写库按题删旧插新；dry-run 默认不写。
- 框图下载走 curl（R2 公共域拒绝 urllib），缓存于 `ocr/figures_cache/`，
  全量 3688 框首跑约 10 分钟，缓存热后重跑 <1 分钟。

## 迁移

- 0012 `question_ocr`：OCR 文本（合并）
- 0013/0014 框指纹 + `pending_ocr_questions` RPC
- 0015 `question_figures`：图形子区域元数据
- 0016 `question_box_ocr`：框级文本（含图形框空内容标记）；
  存量回填 `scripts/backfill_box_ocr.py --write`，增量随 writeback_ocr.py 自动写入

## web 端消费规则（LaTeX 组卷）

- 文本框：`renderLatexHtml`（markdown-it + KaTeX，渲染层共享包 @paper/latex-render）
- 版式：打印 CSS 路线（web/src/lib/latexPaper.ts），A4 一题一页，封面可自定义，
  全卷 Cambria 系（与共享渲染层 render.css 同方案，Caladea webfont 兜底非 Windows），
  KaTeX_Main/Math 字体族覆盖为 Caladea，图形居中
- 题面流：0016 数据齐全时按框重建（框文本 ↔ 框图形精确穿插），
  框内图形 bbox 在框顶 35% 内 → 框文本前；数据不全回退合并文本模式
- `figure` 区：canvas 按 bbox 从框图裁切插入（drawImage 九参）
- `table` 区：题目 OCR 已有 Markdown 表格时跳过（避免双重渲染），否则渲染
- OCR 空 / 纯图形题 / 低置信：回退现有图片模式
