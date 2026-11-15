-- ============================================================
-- 0013: OCR 增量识别支持
--
--   1) question_ocr 增加 boxes_fingerprint：回写时记录"本题识别时
--      的框指纹"（page:box_id:content_hash，页序拼接）。
--   2) RPC pending_ocr_questions()：对比当前框指纹与存储指纹，
--      返回所有待识别题目（新题 / 缺 OCR 行 / 框变更（重裁剪、补框、
--      删框））。题号变化、删了重建等 id 变动天然被覆盖：
--      一切以"当前框内容指纹"为准，不依赖 id 连续性。
--
-- 回写侧（scripts/writeback_ocr.py）写入同规则指纹后，RPC 即自动排除已识别题。
--
-- 执行方式：Supabase Dashboard → SQL Editor 整段执行
-- ============================================================

alter table question_ocr add column if not exists boxes_fingerprint text;

create or replace function public.pending_ocr_questions(max_rows int default 1000)
returns table (question_id bigint, question_no text, boxes jsonb)
language sql
stable
as $$
  with cur as (
    select q.id,
           q.question_no,
           string_agg(
             qb.page::text || ':' || qb.id::text || ':' || coalesce(qb.content_hash, qb.image_key),
             ',' order by qb.page, qb.id
           ) as fp,
           jsonb_agg(jsonb_build_object(
             'box_id', qb.id,
             'page', qb.page,
             'image_key', qb.image_key,
             'content_hash', qb.content_hash
           ) order by qb.page, qb.id) as boxes
    from questions q
    join question_boxes qb on qb.question_id = q.id
    where q.deleted_at is null
    group by q.id, q.question_no
  )
  select c.id, c.question_no, c.boxes
  from cur c
  left join question_ocr o on o.question_id = c.id
  where o.question_id is null
     or o.boxes_fingerprint is distinct from c.fp
  order by c.id
  limit greatest(max_rows, 1);
$$;

grant execute on function public.pending_ocr_questions(int) to authenticated;
