-- ============================================================
-- 0016: 框级 OCR 文本（question_box_ocr，框边界持久化）
--
-- 背景：question_ocr 把多框文本按框序合并，框边界丢失，web 端
-- LaTeX 组卷无法把图形精确插到框与框之间。本表按框存文本，
-- 回填来源：scripts/backfill_box_ocr.py（本地 ocr/cloud_all_out
-- 的 3688 个框级 md，文件名 q{qid}_p{page}_b{box_id}.md）；
-- 增量识别时 writeback_ocr.py 同步写本表。
--
-- 约定：
--   * 每个框一行（含图形框：content=''）；空内容 = 图形框
--   * content 为清洗后文本（与 question_ocr 同一 clean/normalize 规则）
--   * web 端护栏：题目框数 ≠ 本表行数时，整题回退合并文本模式
--
-- 执行方式：Supabase Dashboard → SQL Editor 整段执行
-- ============================================================

create table if not exists question_box_ocr (
  box_id bigint primary key references question_boxes(id) on delete cascade,
  question_id bigint not null references questions(id) on delete cascade,
  page int not null,
  content text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table question_box_ocr enable row level security;

-- 读：与题目可见性一致（admin 全见；其余按 can_see_question）
drop policy if exists p_box_ocr_read on question_box_ocr;
create policy p_box_ocr_read on question_box_ocr for select
  using (is_admin() or can_see_question(question_id));

-- 写：仅 admin（回写走 service key，不受 RLS 约束）
drop policy if exists p_box_ocr_write on question_box_ocr;
create policy p_box_ocr_write on question_box_ocr for all
  using (is_admin())
  with check (is_admin());

create index if not exists idx_box_ocr_question on question_box_ocr (question_id);
