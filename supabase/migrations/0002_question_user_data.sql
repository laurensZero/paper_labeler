-- ============================================================
-- 0002：收藏 / 备注改为「每个账号独立」
--
-- 背景：questions.is_favorite 与 questions.notes 是标注端同步的全局字段，
-- 由管理员统一维护；网页端需要的是同事个人的收藏与个人备注。
-- 新表只存每位用户对每题的个人数据：
--   - 网页端读写自己的行（RLS 强制 user_id = auth.uid()）
--   - 标注端同步的全局 is_favorite/notes 不受影响，网页端不再展示/筛选它们
-- ============================================================

create table if not exists question_user_data (
  question_id bigint not null references questions(id) on delete cascade,
  user_id uuid not null references profiles(id) on delete cascade,
  is_favorite boolean not null default false,
  note text,
  updated_at timestamptz not null default now(),
  primary key (question_id, user_id)
);

create index if not exists idx_qud_user on question_user_data (user_id);

-- updated_at 自动维护（set_updated_at 定义于 0001）
drop trigger if exists trg_qud_updated_at on question_user_data;
create trigger trg_qud_updated_at
  before update on question_user_data
  for each row execute function set_updated_at();

alter table question_user_data enable row level security;

-- 每个人只能读写自己的行
drop policy if exists p_qud_own on question_user_data;
create policy p_qud_own on question_user_data for all
  using (user_id = auth.uid())
  with check (user_id = auth.uid());
