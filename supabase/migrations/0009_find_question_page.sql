-- 0009：题号跳转定位
-- 在数据库端一次完成权限、筛选、题号匹配和页码计算，避免网页端多次查询。

create or replace function public.find_question_page(
  p_question_no text,
  p_years text[] default null,
  p_seasons text[] default null,
  p_paper_ids bigint[] default null,
  p_section text default null,
  p_difficulties smallint[] default null,
  p_include_unset_difficulty boolean default false,
  p_favorite_only boolean default false,
  p_note_keyword text default null,
  p_page_size integer default 50
)
returns table (
  question_id bigint,
  question_no text,
  page_no bigint,
  total_count bigint,
  page_question_ids bigint[]
)
language sql
stable
security invoker
set search_path = public
as $$
  with filtered as (
    select
      q.id,
      q.question_no,
      row_number() over (order by q.id desc) as position,
      count(*) over () as total_count
    from public.questions q
    join public.papers p on p.id = q.paper_id
    where can_see_question(q.id)
      and (p_years is null or p.year_token = any(p_years))
      and (p_seasons is null or p.season_token = any(p_seasons))
      and (p_paper_ids is null or q.paper_id = any(p_paper_ids))
      and (
        p_section is null
        or (p_section = '__UNSET__' and q.section is null and not exists (
          select 1 from public.question_sections qs
          where qs.question_id = q.id
        ))
        or (p_section <> '__UNSET__' and exists (
          select 1 from public.question_sections qs
          where qs.question_id = q.id and qs.section_name = p_section
        ))
      )
      and (
        p_difficulties is null
        or q.difficulty = any(p_difficulties)
        or (p_include_unset_difficulty and q.difficulty is null)
      )
      and (
        not p_favorite_only
        or exists (
          select 1 from public.question_user_data ud
          where ud.question_id = q.id
            and ud.user_id = auth.uid()
            and ud.is_favorite
        )
      )
      and (
        nullif(trim(p_note_keyword), '') is null
        or exists (
          select 1 from public.question_user_data ud
          where ud.question_id = q.id
            and ud.user_id = auth.uid()
            and ud.note ilike '%' || p_note_keyword || '%'
        )
      )
  ), matched as (
    select *
    from filtered
    where question_no = p_question_no
       or question_no ilike '%' || p_question_no || '%'
    order by (question_no = p_question_no) desc, id desc
    limit 1
  )
  select
    matched.id,
    matched.question_no,
    ((matched.position - 1) / greatest(p_page_size, 1)) + 1,
    matched.total_count,
    coalesce(
      array(
        select page_row.id
        from filtered page_row
        where page_row.position > ((matched.position - 1) / greatest(p_page_size, 1)) * greatest(p_page_size, 1)
          and page_row.position <= ((matched.position - 1) / greatest(p_page_size, 1) + 1) * greatest(p_page_size, 1)
        order by page_row.position
      ),
      array[]::bigint[]
    )
  from matched;
$$;
