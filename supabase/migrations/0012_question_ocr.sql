-- ============================================================
-- 0012: 题目 OCR 文本（Xiaomi-OCR-0 识别结果，云端衍生数据）
--
-- 设计要点：
--   * 独立成表、不挂 questions 列 → 本地→云端同步（cloud.py 的
--     questions upsert）不会触碰本表，OCR 回写不会被同步冲掉。
--   * question_id 沿用本地整数 id（与 questions 对齐），级联删除。
--   * 回写脚本（scripts/writeback_ocr.py）走 service_role key，
--     不受 RLS 约束；RLS 仅约束网页端：读与题目可见性一致，写仅 admin。
--
-- 执行方式：Supabase Dashboard → SQL Editor 整段执行
-- ============================================================

create table if not exists question_ocr (
  question_id bigint primary key references questions(id) on delete cascade,
  content text not null,                -- Markdown + LaTeX（\( \) / \[ \]）
  model text not null default 'xiaomi-ocr-0',
  status text not null default 'draft' check (status in ('draft', 'confirmed')),
  source_updated_at timestamptz,        -- 回写时间（服务端生成亦可）
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table question_ocr enable row level security;

-- 读：与 questions 完全同权（admin 全见；其余按 can_see_question）
drop policy if exists p_question_ocr_read on question_ocr;
create policy p_question_ocr_read on question_ocr for select
  using (is_admin() or can_see_question(question_id));

-- 写：仅 admin（MVP 网页端不提供编辑，回写走 service key）
drop policy if exists p_question_ocr_write on question_ocr;
create policy p_question_ocr_write on question_ocr for all
  using (is_admin())
  with check (is_admin());
