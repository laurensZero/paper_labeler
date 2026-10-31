-- ============================================================
-- 0014: OCR 指纹由数据库计算并返回（脚本零计算）
--
--   * pending_ocr_questions() 增加 fingerprint 输出：待识别题的当前
--     框指纹（page:box_id:content_hash）。回写脚本原样存回
--     question_ocr.boxes_fingerprint 即可，下一轮自动排除。
--   * question_fingerprints() 返回全部题目的当前指纹：用于给存量
--     OCR 行补指纹（backfill，纯元数据 join，秒级）。
--
-- 执行方式：Supabase Dashboard → SQL Editor 整段执行
-- ============================================================

-- 0013 版本返回类型不含 fingerprint，需先 DROP 再建（42P13）
drop function if exists public.pending_ocr_questions(int);
drop function if exists public.question_fingerprints();

create function public.pending_ocr_questions(max_rows int default 1000)
returns table (question_id bigint, question_no text, fingerprint text, boxes jsonb)
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
  select c.id, c.question_no, c.fp, c.boxes
  from cur c
  left join question_ocr o on o.question_id = c.id
  where o.question_id is null
     or o.boxes_fingerprint is distinct from c.fp
  order by c.id
  limit greatest(max_rows, 1);
$$;

create or replace function public.question_fingerprints()
returns table (question_id bigint, fingerprint text)
language sql
stable
as $$
  select q.id,
         string_agg(
           qb.page::text || ':' || qb.id::text || ':' || coalesce(qb.content_hash, qb.image_key),
           ',' order by qb.page, qb.id
         ) as fp
  from questions q
  join question_boxes qb on qb.question_id = q.id
  where q.deleted_at is null
  group by q.id
  order by q.id;
$$;

grant execute on function public.pending_ocr_questions(int) to authenticated;
grant execute on function public.question_fingerprints() to authenticated;
