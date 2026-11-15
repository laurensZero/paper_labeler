-- ============================================================
-- 0015: 题目框级图形元数据（scripts/split_figures.py CV 自动切分）
--
-- 背景：题目图形多与文字同框（如曲线图在上、题干在下），OCR 文本
-- （question_ocr）不含图形信息；LaTeX 组卷需要图形子区域才能图文混排。
--
-- 设计要点：
--   * 只存 bbox（框图相对像素坐标 [x,y,w,h]），不单独切图上传：
--     前端从 question_boxes 框图 canvas 按 bbox 裁切（drawImage 九参），
--     免 R2 上传通道，元数据天然跟随框图。
--   * boxes_fingerprint 同 0013 规则：框重裁/补删框后指纹变化，
--     split_figures.py 重跑即自动刷新该题元数据。
--   * full_box = 图形区覆盖 >85% 框面积（整框纯图形，LaTeX 组卷时该框无文本）。
--   * confidence < 1（细横条，如数轴）建议前端复核后使用。
--
-- 执行方式：Supabase Dashboard → SQL Editor 整段执行
-- ============================================================

create table if not exists question_figures (
  id bigserial primary key,
  question_id bigint not null references questions(id) on delete cascade,
  box_id bigint not null references question_boxes(id) on delete cascade,
  ord int not null default 0,          -- 框内第几个图形区
  bbox jsonb not null,                 -- [x, y, w, h]，框图相对像素坐标
  confidence real not null default 1,
  full_box boolean not null default false,
  kind text not null default 'figure' check (kind in ('figure', 'table')),
  boxes_fingerprint text,
  created_at timestamptz not null default now(),
  unique (box_id, ord)
);

alter table question_figures enable row level security;

-- 读：与题目可见性一致（admin 全见；其余按 can_see_question）
drop policy if exists p_question_figures_read on question_figures;
create policy p_question_figures_read on question_figures for select
  using (is_admin() or can_see_question(question_id));

-- 写：仅 admin（回写走 service key，不受 RLS 约束）
drop policy if exists p_question_figures_write on question_figures;
create policy p_question_figures_write on question_figures for all
  using (is_admin())
  with check (is_admin());

create index if not exists idx_figures_question on question_figures (question_id);
