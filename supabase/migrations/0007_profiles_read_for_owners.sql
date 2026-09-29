-- 组卷列表显示「所有人」：登录用户可读 profiles（至少 id/email）。
-- 旧策略 id = auth.uid() or is_admin() 会导致 join profiles(email) 对他人恒为 null。
-- 邮箱对同事可见与共享组卷语义一致；role/quota 等敏感字段如需收紧可再拆视图。

drop policy if exists p_profiles_read on profiles;
create policy p_profiles_read on profiles for select
  using (auth.role() = 'authenticated');
