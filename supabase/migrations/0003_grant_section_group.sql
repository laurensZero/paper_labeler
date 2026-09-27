-- ============================================================
-- 0003：可见范围授权支持「大类」（section_group）
--
-- 原 can_see_question 只匹配小类名（question_sections / questions.section），
-- 管理端若授予大类，网页端会误判为「无权限」。
-- 新增 scope = 'section_group'，通过 section_group_members 展开到小类。
-- ============================================================

create or replace function can_see_question(q_id bigint)
returns boolean
language plpgsql
security definer
stable
set search_path = public
as $$
declare
  uid uuid := auth.uid();
  prof profiles%rowtype;
  q questions%rowtype;
  has_grant_rows boolean;
begin
  if uid is null then
    return false;
  end if;

  select * into prof from profiles where id = uid;
  if not found then
    return false;
  end if;

  if prof.role = 'admin' then
    return true;
  end if;

  select * into q from questions where id = q_id;
  if not found or q.deleted_at is not null then
    return false;
  end if;

  -- 未校对题：与 grants 同一套开关
  if q.status <> 'confirmed' and not prof.can_see_drafts then
    return false;
  end if;

  -- 内测默认：无任何 grant 行的 teacher 可见全部 confirmed
  select exists (select 1 from question_grants g where g.user_id = uid)
    into has_grant_rows;
  if not has_grant_rows then
    return true;
  end if;

  -- 单题
  if exists (
    select 1 from question_grants g
    where g.user_id = uid and g.scope = 'question'
      and g.scope_value = q_id::text
  ) then
    return true;
  end if;

  -- 整卷
  if exists (
    select 1 from question_grants g
    where g.user_id = uid and g.scope = 'paper'
      and g.scope_value = q.paper_id::text
  ) then
    return true;
  end if;

  -- 小类（含旧版 questions.section）
  if exists (
    select 1 from question_grants g
    where g.user_id = uid and g.scope = 'section'
      and (
        g.scope_value = coalesce(q.section, '')
        or exists (
          select 1 from question_sections qs
          where qs.question_id = q_id and qs.section_name = g.scope_value
        )
      )
  ) then
    return true;
  end if;

  -- 大类：组名 → 组内全部小类
  if exists (
    select 1
    from question_grants g
    join section_groups sg on sg.name = g.scope_value
    join section_group_members gm on gm.group_id = sg.id
    where g.user_id = uid and g.scope = 'section_group'
      and (
        gm.section_name = coalesce(q.section, '')
        or exists (
          select 1 from question_sections qs
          where qs.question_id = q_id and qs.section_name = gm.section_name
        )
      )
  ) then
    return true;
  end if;

  return false;
end;
$$;

-- 放宽 grants scope 枚举，允许 section_group
alter table question_grants drop constraint if exists question_grants_scope_check;
alter table question_grants add constraint question_grants_scope_check
  check (scope in ('section', 'section_group', 'paper', 'question'));
