-- ============================================================
-- 0004：组卷/导出限额（周期制）+ 双水印配置
--
-- 配套管理端「云端管理 → 导出管控」：
--   1) profiles 限额（null = 不限）：
--        max_compositions     组卷存量上限
--        max_exports_per_week 导出次数·本周上限（防批量偷题库）
--        max_exports_per_month导出次数·本月上限
--        max_export_items     单次导出题目数上限（题库导出与组卷导出同受此限）
--   2) app_config：网页浏览水印 + 导出水印（预设/自定义文本）
--   3) 触发器兜底：组卷创建、导出次数落库时在数据库层校验
--
-- TODO(停用用户/封号)：本版先不做。后续加 profiles.is_active 并调用
--   GoTrue admin ban（ban_duration）真正禁止登录，网页端登录时校验。
--
-- 注意：本文件在会话内修订过（旧版导出限额为累计制 max_exports）。
--   若已在 Supabase 执行过更早版本的 0004，请先执行：
--     alter table profiles drop column if exists max_exports;
--   （其余语句均幂等，可直接重跑本文件）
-- ============================================================

-- ===== 限额列（null = 不限）=====

alter table profiles
  add column if not exists max_compositions int
  check (max_compositions is null or max_compositions >= 0);

alter table profiles
  add column if not exists max_exports_per_week int
  check (max_exports_per_week is null or max_exports_per_week >= 0);

alter table profiles
  add column if not exists max_exports_per_month int
  check (max_exports_per_month is null or max_exports_per_month >= 0);

alter table profiles
  add column if not exists max_export_items int
  check (max_export_items is null or max_export_items >= 0);

-- 旧版累计制残留列（若执行过会话内早期的 0004）
alter table profiles drop column if exists max_exports;

-- ===== 全局配置（key-value；客户端只读，写入仅 service role）=====

create table if not exists app_config (
  key text primary key,
  value jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table app_config enable row level security;

drop policy if exists p_app_config_read on app_config;
create policy p_app_config_read on app_config for select
  using (auth.role() = 'authenticated');
-- 无写策略：只有标注端后端的 service role 能改（绕过 RLS）

drop trigger if exists trg_app_config_updated_at on app_config;
create trigger trg_app_config_updated_at
  before update on app_config
  for each row execute function set_updated_at();

-- 双水印结构：mode = preset（预设：{email}/{date} 展开）| custom（自定义文本）
insert into app_config (key, value)
values ('export', '{
  "export_watermark": {"enabled": false, "mode": "preset", "text": ""},
  "browse_watermark": {"enabled": true,  "mode": "preset", "text": ""}
}'::jsonb)
on conflict (key) do nothing;

-- ===== 组卷限额触发器（创建/复制组卷时兜底拦截）=====

create or replace function enforce_composition_quota()
returns trigger
language plpgsql
as $$
declare
  mx int;
  used int;
begin
  if new.owner_id is null then
    return new;
  end if;
  select max_compositions into mx from profiles where id = new.owner_id;
  if mx is not null then
    select count(*) into used from compositions where owner_id = new.owner_id;
    if used >= mx then
      raise exception 'quota_exceeded:compositions max=%', mx;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_composition_quota on compositions;
create trigger trg_composition_quota
  before insert on compositions
  for each row execute function enforce_composition_quota();

-- ===== 导出次数限额触发器（周/月窗口；failed 不计数）=====

create or replace function enforce_export_quota()
returns trigger
language plpgsql
as $$
declare
  mx_week int;
  mx_month int;
  used int;
begin
  if new.requested_by is null or new.status = 'failed' then
    return new;
  end if;
  select max_exports_per_week, max_exports_per_month
    into mx_week, mx_month
    from profiles where id = new.requested_by;

  if mx_week is not null then
    select count(*) into used
      from export_jobs
     where requested_by = new.requested_by
       and status <> 'failed'
       and created_at >= date_trunc('week', now());
    if used >= mx_week then
      raise exception 'quota_exceeded:exports_week max=%', mx_week;
    end if;
  end if;

  if mx_month is not null then
    select count(*) into used
      from export_jobs
     where requested_by = new.requested_by
       and status <> 'failed'
       and created_at >= date_trunc('month', now());
    if used >= mx_month then
      raise exception 'quota_exceeded:exports_month max=%', mx_month;
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_export_quota on export_jobs;
create trigger trg_export_quota
  before insert on export_jobs
  for each row execute function enforce_export_quota();
