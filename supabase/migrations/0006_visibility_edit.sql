-- 组卷共享三态：private | view | edit
-- 旧值 'shared' 语义等同「仅查看」，迁移到 'view'。
-- 非 owner 在 visibility='edit' 时可写 compositions / composition_items。

-- 1. 旧值迁移
update compositions set visibility = 'view' where visibility = 'shared';

-- 2. 扩展 check 约束
alter table compositions drop constraint if exists compositions_visibility_check;
alter table compositions
  add constraint compositions_visibility_check
  check (visibility in ('private', 'view', 'edit'));

-- 3. 读策略：private 仅本人/admin；view、edit 共享可见
drop policy if exists p_compositions_read on compositions;
create policy p_compositions_read on compositions for select
  using (is_admin() or owner_id = auth.uid() or visibility in ('view', 'edit'));

drop policy if exists p_comp_items_read on composition_items;
create policy p_comp_items_read on composition_items for select
  using (
    exists (
      select 1 from compositions c
      where c.id = composition_items.composition_id
        and (is_admin() or c.owner_id = auth.uid() or c.visibility in ('view', 'edit'))
    )
  );

-- 4. 写策略：owner/admin，或 visibility='edit' 的协作者
--    with check 要求新行仍为 edit，防止协作者把共享级别改掉
drop policy if exists p_compositions_update on compositions;
create policy p_compositions_update on compositions for update
  using (is_admin() or owner_id = auth.uid() or visibility = 'edit')
  with check (is_admin() or owner_id = auth.uid() or visibility = 'edit');

drop policy if exists p_comp_items_write on composition_items;
create policy p_comp_items_write on composition_items for all
  using (
    exists (
      select 1 from compositions c
      where c.id = composition_items.composition_id
        and (is_admin() or c.owner_id = auth.uid() or c.visibility = 'edit')
    )
  )
  with check (
    exists (
      select 1 from compositions c
      where c.id = composition_items.composition_id
        and (is_admin() or c.owner_id = auth.uid() or c.visibility = 'edit')
    )
  );
