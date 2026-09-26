-- ============================================================
-- Paper Labeler 云端初始化（Supabase / Postgres）
-- 执行方式：Supabase Dashboard → SQL Editor 整段执行
-- 或本地 supabase CLI: supabase db push
--
-- 与设计稿 index.html §5 对齐，并补齐两处实施修正：
--   1) 新增 export_jobs 表（设计稿遗漏：网页端需要追踪导出任务状态）
--   2) question_boxes/answer_boxes 增加 content_hash（图片按内容
--      去重、跳过重复上传；R2 key 仍按 id 组织，二者不冲突）
-- ============================================================

-- ===== 身份与权限 =====

create table if not exists profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text unique not null,
  role text not null default 'teacher' check (role in ('admin', 'teacher')),
  can_see_drafts boolean not null default false,
  created_at timestamptz not null default now()
);

-- 题目可见性授予：无该用户任何行 = 按内测默认策略（见 can_see_question）
create table if not exists question_grants (
  id bigserial primary key,
  user_id uuid not null references profiles(id) on delete cascade,
  scope text not null check (scope in ('section', 'paper', 'question')),
  scope_value text not null,
  created_at timestamptz not null default now(),
  unique (user_id, scope, scope_value)
);

-- 注册后自动建 profile（MVP：注册入口关闭，用户由 admin 在
-- Supabase Dashboard 创建；该触发器保证 role 落库）
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email)
  values (new.id, new.email)
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ===== 题库（与本地 SQLite 对齐；路径列改为 R2 key）=====

create table if not exists papers (
  id bigint primary key,              -- 同步保留本地整数 id
  filename text not null,
  exam_code text,
  year_token text,
  season_token text,
  is_answer boolean not null default false,
  paired_paper_id bigint,
  page_count int,
  done boolean not null default false,
  source_updated_at timestamptz,      -- 本地最后修改时间
  deleted_at timestamptz,             -- 软删（tombstone）
  created_at timestamptz not null default now()
);

create table if not exists questions (
  id bigint primary key,
  paper_id bigint not null references papers(id),
  question_no text,
  section text,                       -- 旧版冗余字段，随 question_sections 一起同步
  status text not null default 'draft' check (status in ('draft', 'confirmed')),
  notes text,
  is_favorite boolean not null default false,
  source_updated_at timestamptz,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists question_boxes (
  id bigint primary key,
  question_id bigint not null references questions(id) on delete cascade,
  paper_id bigint not null,
  page int not null,
  bbox jsonb not null,
  image_key text not null,            -- R2 key，不再存本地绝对路径
  content_hash text,                  -- 图片 sha256；同步时用于跳过未变更图
  created_at timestamptz not null default now()
);

create table if not exists answers (
  id bigint primary key,
  question_id bigint unique not null references questions(id),
  ms_paper_id bigint not null references papers(id),
  notes text,
  source_updated_at timestamptz,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists answer_boxes (
  id bigint primary key,
  answer_id bigint not null references answers(id) on delete cascade,
  ms_paper_id bigint not null,
  page int not null,
  bbox jsonb not null,
  image_key text not null,
  content_hash text,
  created_at timestamptz not null default now()
);

create table if not exists section_defs (
  id bigint primary key,
  name text unique not null,
  content text,
  color text,
  source_updated_at timestamptz,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists section_groups (
  id bigint primary key,
  name text unique not null,
  show_in_filter boolean not null default true,
  source_updated_at timestamptz,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists section_group_members (
  id bigserial primary key,
  group_id bigint not null references section_groups(id) on delete cascade,
  section_name text not null unique,
  created_at timestamptz not null default now()
);

create table if not exists question_sections (
  id bigserial primary key,
  question_id bigint not null references questions(id) on delete cascade,
  section_name text not null,
  created_at timestamptz not null default now(),
  unique (question_id, section_name)
);

-- ===== 组卷（云端新建，uuid；与本地 compositions 互不相通）=====

create table if not exists compositions (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  title text,
  header_text text,
  footer_text text,
  cover_lines text,                   -- JSON 数组：封面行（姓名/分数/时间）
  include_answers boolean not null default false,
  answers_placement text not null default 'end' check (answers_placement in ('end', 'interleaved')),
  group_by_section boolean not null default true,
  show_section_headers boolean not null default true,
  show_question_info boolean not null default true,
  show_page_numbers boolean not null default true,
  owner_id uuid not null references profiles(id),
  visibility text not null default 'private' check (visibility in ('private', 'shared')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists composition_items (
  id bigserial primary key,
  composition_id uuid not null references compositions(id) on delete cascade,
  question_id bigint references questions(id),
  sort_order int not null default 0,
  item_type text not null default 'question' check (item_type in ('question', 'blank_page')),
  blank_pages int not null default 0,
  score float,
  custom_header text,
  created_at timestamptz not null default now()
);
-- 空白页 question_id 为 null，PG 中 null 不参与唯一性，可插入多条

create unique index if not exists uq_comp_question
  on composition_items (composition_id, question_id)
  where question_id is not null;

-- ===== 建议 =====

create table if not exists suggestions (
  id bigserial primary key,
  question_id bigint not null references questions(id) on delete cascade,
  user_id uuid references profiles(id),
  body text not null,
  status text not null default 'open' check (status in ('open', 'accepted', 'rejected')),
  created_at timestamptz not null default now()
);

-- ===== 导出任务（设计稿遗漏，实施补齐）=====

create table if not exists export_jobs (
  id uuid primary key default gen_random_uuid(),
  composition_id uuid references compositions(id) on delete set null,
  requested_by uuid references profiles(id),
  include_answers boolean not null default false,
  status text not null default 'queued' check (status in ('queued', 'running', 'done', 'failed')),
  error text,
  options jsonb not null default '{}'::jsonb,
  result_key text,                    -- R2: exports/{job_id}/paper.pdf
  created_at timestamptz not null default now(),
  finished_at timestamptz
);

-- ===== 同步审计（仅标注端 service role 写入）=====

create table if not exists sync_log (
  id bigserial primary key,
  entity text not null,
  entity_id text not null,
  action text not null,               -- upsert | delete | image_upload
  payload_hash text,
  created_at timestamptz not null default now()
);

-- ===== 索引 =====

create index if not exists idx_papers_tokens on papers (year_token, season_token);
create index if not exists idx_questions_paper on questions (paper_id);
create index if not exists idx_questions_status on questions (status) where deleted_at is null;
create index if not exists idx_qboxes_question on question_boxes (question_id);
create index if not exists idx_qboxes_hash on question_boxes (content_hash);
create index if not exists idx_aboxes_answer on answer_boxes (answer_id);
create index if not exists idx_aboxes_hash on answer_boxes (content_hash);
create index if not exists idx_qsections_question on question_sections (question_id);
create index if not exists idx_qsections_name on question_sections (section_name);
create index if not exists idx_grants_user on question_grants (user_id);
create index if not exists idx_compositions_owner on compositions (owner_id);
create index if not exists idx_comp_items_comp on composition_items (composition_id, sort_order);
create index if not exists idx_suggestions_q on suggestions (question_id);
create index if not exists idx_suggestions_status on suggestions (status);
create index if not exists idx_export_jobs_status on export_jobs (status);
create index if not exists idx_export_jobs_owner on export_jobs (requested_by);
create index if not exists idx_sync_log_created on sync_log (created_at);

-- ===== updated_at 自动维护（仅网页端写入的表）=====

create or replace function set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_compositions_updated_at on compositions;
create trigger trg_compositions_updated_at
  before update on compositions
  for each row execute function set_updated_at();

-- ===== 可见性判定（与设计稿 §6 伪代码一致）=====

create or replace function is_admin()
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1 from profiles where id = auth.uid() and role = 'admin'
  );
$$;

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

  if exists (
    select 1 from question_grants g
    where g.user_id = uid and g.scope = 'question'
      and g.scope_value = q_id::text
  ) then
    return true;
  end if;

  if exists (
    select 1 from question_grants g
    where g.user_id = uid and g.scope = 'paper'
      and g.scope_value = q.paper_id::text
  ) then
    return true;
  end if;

  -- section grant 同时匹配 question_sections 与旧版 questions.section
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

  return false;
end;
$$;

-- ===== RLS =====

alter table profiles enable row level security;
alter table question_grants enable row level security;
alter table papers enable row level security;
alter table questions enable row level security;
alter table question_boxes enable row level security;
alter table answers enable row level security;
alter table answer_boxes enable row level security;
alter table section_defs enable row level security;
alter table section_groups enable row level security;
alter table section_group_members enable row level security;
alter table question_sections enable row level security;
alter table compositions enable row level security;
alter table composition_items enable row level security;
alter table suggestions enable row level security;
alter table export_jobs enable row level security;
alter table sync_log enable row level security;

-- profiles
drop policy if exists p_profiles_read on profiles;
create policy p_profiles_read on profiles for select
  using (id = auth.uid() or is_admin());

-- question_grants：自己可读；admin 全管（写入主要走 service role）
drop policy if exists p_grants_read on question_grants;
create policy p_grants_read on question_grants for select
  using (user_id = auth.uid() or is_admin());
drop policy if exists p_grants_admin on question_grants;
create policy p_grants_admin on question_grants for all
  using (is_admin()) with check (is_admin());

-- papers：元数据供筛选下拉使用；内容级管控落在 questions/boxes
drop policy if exists p_papers_read on papers;
create policy p_papers_read on papers for select
  using (auth.role() = 'authenticated');

-- questions / boxes / answers：唯一判定入口 can_see_question
drop policy if exists p_questions_read on questions;
create policy p_questions_read on questions for select
  using (is_admin() or can_see_question(id));

drop policy if exists p_qboxes_read on question_boxes;
create policy p_qboxes_read on question_boxes for select
  using (is_admin() or can_see_question(question_id));

drop policy if exists p_answers_read on answers;
create policy p_answers_read on answers for select
  using (is_admin() or can_see_question(question_id));

drop policy if exists p_aboxes_read on answer_boxes;
create policy p_aboxes_read on answer_boxes for select
  using (
    is_admin()
    or exists (
      select 1 from answers a
      where a.id = answer_boxes.answer_id and can_see_question(a.question_id)
    )
  );

drop policy if exists p_qsections_read on question_sections;
create policy p_qsections_read on question_sections for select
  using (is_admin() or can_see_question(question_id));

-- section 字典：登录即可读；写入只在标注端（service role）/admin
drop policy if exists p_section_defs_read on section_defs;
create policy p_section_defs_read on section_defs for select
  using (auth.role() = 'authenticated');
drop policy if exists p_section_groups_read on section_groups;
create policy p_section_groups_read on section_groups for select
  using (auth.role() = 'authenticated');
drop policy if exists p_group_members_read on section_group_members;
create policy p_group_members_read on section_group_members for select
  using (auth.role() = 'authenticated');

-- compositions：自己的 + shared 的；admin 全可见
drop policy if exists p_compositions_read on compositions;
create policy p_compositions_read on compositions for select
  using (is_admin() or owner_id = auth.uid() or visibility = 'shared');
drop policy if exists p_compositions_insert on compositions;
create policy p_compositions_insert on compositions for insert
  with check (owner_id = auth.uid());
drop policy if exists p_compositions_update on compositions;
create policy p_compositions_update on compositions for update
  using (is_admin() or owner_id = auth.uid());
drop policy if exists p_compositions_delete on compositions;
create policy p_compositions_delete on compositions for delete
  using (is_admin() or owner_id = auth.uid());

-- composition_items：随父卷策略；写入仅限本人（或 admin）
drop policy if exists p_comp_items_read on composition_items;
create policy p_comp_items_read on composition_items for select
  using (
    exists (
      select 1 from compositions c
      where c.id = composition_items.composition_id
        and (is_admin() or c.owner_id = auth.uid() or c.visibility = 'shared')
    )
  );
drop policy if exists p_comp_items_write on composition_items;
create policy p_comp_items_write on composition_items for all
  using (
    exists (
      select 1 from compositions c
      where c.id = composition_items.composition_id
        and (is_admin() or c.owner_id = auth.uid())
    )
  )
  with check (
    exists (
      select 1 from compositions c
      where c.id = composition_items.composition_id
        and (is_admin() or c.owner_id = auth.uid())
    )
  );

-- suggestions：登录可提；自己与 admin 可见；admin 处理
drop policy if exists p_suggestions_read on suggestions;
create policy p_suggestions_read on suggestions for select
  using (is_admin() or user_id = auth.uid());
drop policy if exists p_suggestions_insert on suggestions;
create policy p_suggestions_insert on suggestions for insert
  with check (user_id = auth.uid());
drop policy if exists p_suggestions_update on suggestions;
create policy p_suggestions_update on suggestions for update
  using (is_admin());

-- export_jobs：自己的任务；admin 可见
drop policy if exists p_export_jobs_read on export_jobs;
create policy p_export_jobs_read on export_jobs for select
  using (is_admin() or requested_by = auth.uid());
drop policy if exists p_export_jobs_insert on export_jobs;
create policy p_export_jobs_insert on export_jobs for insert
  with check (requested_by = auth.uid());

-- sync_log：仅 service role（标注端）写入与读取
drop policy if exists p_sync_log_admin on sync_log;
create policy p_sync_log_admin on sync_log for select
  using (is_admin());
