-- 0010：卷内题号（「该试卷的第几题」）
-- 网页端题库信息卡要显示的是卷内序号，而不是题库全局 question_no。
-- 与标注端 backend/routers/questions.py::_paper_qno_map 同一套定义：
--   按「该题第一个裁剪框的页号 → 框内 y0」在整份试卷内排序，1 起编号；
--   没有裁剪框的题排在最后。
--
-- security definer：卷内序号必须按整份试卷计算，不能随调用者的可见范围
-- （未校对题、按试卷/模块/单题授权）漂移，否则同一道题在不同账号下编号不同。
-- 只回传调用方点名要的那些题，不额外暴露被隐藏题的内容。

create or replace function public.paper_qno_map(p_question_ids bigint[])
returns table (question_id bigint, paper_qno integer)
language sql
stable
security definer
set search_path = public
as $$
  with targets as (
    select distinct q.paper_id
    from public.questions q
    where q.id = any(p_question_ids)
  ),
  pool as (
    select q.id, q.paper_id
    from public.questions q
    join targets t on t.paper_id = q.paper_id
    where q.deleted_at is null
  ),
  boxes as (
    select
      b.question_id,
      b.page,
      case
        when jsonb_typeof(b.bbox) = 'array'
          and (b.bbox ->> 1) ~ '^\s*-?[0-9]+(\.[0-9]+)?([eE][-+]?[0-9]+)?\s*$'
        then (b.bbox ->> 1)::double precision
        else 0
      end as y0
    from public.question_boxes b
    join pool on pool.id = b.question_id
  ),
  first_box as (
    select distinct on (question_id) question_id, page, y0
    from boxes
    order by question_id, page asc, y0 asc
  ),
  ranked as (
    select
      pool.id,
      row_number() over (
        partition by pool.paper_id
        order by
          coalesce(first_box.page, 2147483647),
          coalesce(first_box.y0, 0),
          pool.id
      ) as rn
    from pool
    left join first_box on first_box.question_id = pool.id
  )
  select r.id as question_id, r.rn::integer as paper_qno
  from ranked r
  where r.id = any(p_question_ids);
$$;

comment on function public.paper_qno_map(bigint[]) is
  '卷内题号：给定题目 id，返回它在所属试卷中的第几题（1 起，按首个裁剪框的页号/y0 排序）';
