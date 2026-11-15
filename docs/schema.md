# 云端 Supabase Schema 清单（真源）

> 2026-11-15 审计。行数来自当日 `scripts/cloud_inventory.py` 线上实测。
> **线上库与 migrations/ 已出现漂移**（见文末），改动 schema 前先对照本文件 + 线上实况。

## 一、核心题库数据（同步管线写入，本地整数 id 保留）

| 表 | 行数 | 谁写 | 谁读 | 删语义 | 备注 |
|---|---|---|---|---|---|
| papers | 389 | backend sync | web BankView / 导出 | 软删 tombstone | 本地 id 直同步 |
| questions | 1632 | backend sync | web / 导出 / RLS | 软删 | `section` 是旧冗余列（见乱点③）；`is_favorite` 与 user_data 双轨（见乱点②） |
| question_boxes | 3688 | backend sync | web 取图 | **硬删** | `content_hash` 实为"页图 stat+bbox 指纹"（非像素哈希） |
| answers | 1611 | backend sync | web | 软删 | question_id 1:1 |
| answer_boxes | 2579 | backend sync | web | **硬删** | 同上，指纹语义 |
| question_sections | 1715 | backend sync（link diff） | web / 筛选 | **硬删** | 多对多，取代 questions.section |
| section_defs | 43 | backend sync | web | 软删 | 分类字典 |
| section_groups / members | 5 / 43 | backend sync | web | 软删 / 硬删 | 分组视图 |

## 二、OCR 管线（0021 前不参与 sync，独立生态）

| 表 | 谁写 | 谁读 | 备注 |
|---|---|---|---|
| question_ocr | B 机回写脚本 / 管理端校对 PUT（走 backend service key） | web OCR 面板 / 管理端校对队列 | `status` draft/confirmed（校对状态，**与 questions.status 同名不同义**）；`boxes_fingerprint` 由 0014 RPC 计算返回，与 `question_boxes.content_hash` 是两套指纹（见乱点④） |
| question_figures（0015） | 回写脚本（图形框剥离） | web / 组卷 | hash 重写引入；线上是否已执行待确认 |

依赖 RPC：`pending_ocr_questions`（0014 版，指纹库侧算）、`question_fingerprints`、`paper_qno_map`。

## 三、用户协作（web 端，anon key + RLS）

| 表 | 行数 | 用途 | 状态 |
|---|---|---|---|
| profiles | 2 | 角色/额度/is_active | **2 行全是 admin**（含 1 个 test 账号）——额度/禁用体系是为"未来开 teacher"预留，当前空转 |
| question_user_data | 少量 | 每账号收藏/备注（web BankView） | 在用；**与 questions.is_favorite 并存**（见乱点②） |
| question_grants | **0** | 题目级可见性覆盖（can_see_question 的可选层） | 0 行 = 默认策略，功能预留未启用 |
| suggestions | **0** | web 反馈 | 刚上线，无数据 |
| compositions / items | 2 / 5 | 组卷（uuid 体系，与本地互不相通） | 在用，量小 |
| app_config | ? | 水印/全局配置（0004） | 在用（web 水印读写）；inventory 脚本列名假设已过期 |

## 四、辅助

| 表 | 行数 | 用途 |
|---|---|---|
| sync_log | 2 | 同步审计（每轮 1 行） |
| export_jobs | **0** | **不在任何 migration 里**——线上手工建的，见乱点① |

## 乱点清单（按危害排序）

① **迁移文件 ≠ 线上库**：`export_jobs` 只存在于线上；`cloud_inventory.py` 对 question_user_data / app_config 的列名假设报 42703。没有 schema 真源，每次改表全靠记忆。
→ 治法：本文件为真源 + 新迁移 0016 把线上漂移纳入版本控制 + 修 inventory 脚本列名。

② **双轨收藏**：`questions.is_favorite`（标注端同步的全局收藏）vs `question_user_data.is_favorite`（web 用户级收藏）。web 两个都在读（BankView 走 user_data，CompositionView 走 questions）。
→ 治法：先明确语义（标注员精选 vs 同事个人收藏），写进本文件；合并是中期的活。

③ **questions.section 旧冗余列**仍在被 web 读（radar.ts / CompositionView 的 fallback 路径）。
→ 治法：web 去掉 fallback → 确认无读取 → drop 列（一次小迁移 + 两端发版）。

④ **两套指纹命名**：`question_boxes.content_hash`（图片指纹，名字叫 hash）vs `question_ocr.boxes_fingerprint`（框指纹，0014 起由 RPC 算）。
→ 治法：不改名（成本高），本文件注明语义 + 各自公式出处即可。

⑤ **预留子系统空转**：grants / 额度 / is_active，服务对象（teacher 账号）不存在。**不建议删**——开同事账号那天就要用，且 RLS can_see_question 引用着 grants。

## 不动的部分（设计使然）

- id 体系：题库本地整数 id 直同步（question_ocr 依赖），组卷 uuid——两套并存是历史决定。
- 软删/硬删不一致：主记录软删（tombstone 防误删）、boxes/链接表硬删（可由本地全量重建）——同步机制依赖，勿改。
