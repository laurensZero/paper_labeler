# 数据模型与边界

本地标注端（SQLite `data/app.db`）与云端（Supabase + R2）的职责边界。改表或同步前先看这里。

## 总原则

- **本地是标注写入源**：题目/答案/框的唯一生产端是桌面标注应用。
- **云是发布面**：网页端（`web/`）读云端数据做浏览/组卷/导出；个人收藏与备注写 `question_user_data`。
- **不同步整页图/PDF**：页图只在本地 `data/pages/`；云端只存裁切框图（R2 `image_key` + `content_hash`）。

## 本地 SQLite ↔ 云端对照

| 本地表 | 云端表 | 同步方向 | 说明 |
|--------|--------|----------|------|
| `papers` | `papers` | 本地 → 云 | id 保留整型；`updated_at`/`source_updated_at` 脏检查 |
| `questions` | `questions` | 本地 → 云 | `question_no` 全局流水号 |
| `question_boxes` | `question_boxes` | 本地 → 云 | 本地图 `image_path`，云端 `image_key`（R2） |
| `answers` | `answers` | 本地 → 云 | `question_id` 唯一 |
| `answer_boxes` | `answer_boxes` | 本地 → 云 | 同框图策略 |
| `question_sections` | 链接表 | 本地 → 云 | 按题标签 |
| `section_defs` / `section_groups` / `section_group_members` | 同名 | 本地 → 云 | `section_group_members.section_name` 全局唯一（一模块只进一组） |
| `compositions` / `composition_items` | （独立） | **不互通** | 本地组卷整型 id；云端组卷 uuid，网页端自建 |
| — | `profiles` / `question_grants` | 仅云端 | 账号与可见性授权 |
| — | `question_user_data` | 仅云端 | 网页端个人收藏/备注 |
| — | `suggestions` / `export_jobs` | 仅云端 | 网页端反馈与导出任务 |

## 明确不同步

- 全部 localStorage 设置/历史/筛选预设（可用设置快照导出文件迁移）
- 整页 WebP / PDF
- 本地组卷 `compositions`
- `cache:*` 运行时缓存

## 本地关键约束

- `papers.filename` UNIQUE
- `answers.question_id` UNIQUE
- `question_sections (question_id, section_name)` UNIQUE
- `questions.question_no` 全局唯一（非空）
- `papers.updated_at` 云脏检查依赖列（升级后由 `init_db` 回填）

## UI 边界提示

- 组卷页：**「本机组卷不会同步到云端网页端」**
- 设置页云同步：单向推；本地删除 → 云端软删（`deleted_at`）

## 改表检查清单

1. 本地 `backend/database.py` + `init_db()` 迁移
2. 若上云：`supabase/migrations/` 对齐字段与 RLS
3. `backend/cloud/sync.py` 字段映射
4. 更新本表
