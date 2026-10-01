-- 0011：管理员不再代管他人的「私有」组卷
--
-- 之前 is_admin() 让 admin 对任意组卷（含他人私有的）都有改/删权限。现在 admin 只相当于
-- 一个普通协作者：
--   * 读：仍然全可见（排查/支持用）——p_compositions_read 不动
--   * 改：本人，或该卷已设为「公开可编辑」(= visibility 'edit')
--   * 删：本人；admin 只能删「已公开」的卷，私有一律不许动
--
-- 顺带补一个洞：owner_id 不可被非本人改写。原 with check 只看新行，协作者可以把他人
-- 「公开可编辑」的卷 owner_id 改成自己、再设为 private 据为己有（策略里带子查询也拦不住：
-- 函数内的查询会看到本命令刚写入的新行，只能靠触发器比对 OLD/NEW）。

drop policy if exists p_compositions_update on compositions;
create policy p_compositions_update on compositions for update
  using (owner_id = auth.uid() or visibility = 'edit')
  with check (owner_id = auth.uid() or visibility = 'edit');

create or replace function public.compositions_keep_owner()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  -- auth.uid() 为 null 时是 service role（标注端/运维），放行；普通账号只能改自己的卷
  if new.owner_id is distinct from old.owner_id
     and auth.uid() is not null
     and old.owner_id is distinct from auth.uid() then
    raise exception 'composition_owner_immutable' using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_compositions_keep_owner on compositions;
create trigger trg_compositions_keep_owner
  before update on compositions
  for each row execute function public.compositions_keep_owner();

-- 删：本人；admin 仅限已公开的卷
drop policy if exists p_compositions_delete on compositions;
create policy p_compositions_delete on compositions for delete
  using (owner_id = auth.uid() or (is_admin() and visibility <> 'private'));

-- 条目：随父卷的写权限，不再给 admin 兜底
drop policy if exists p_comp_items_write on composition_items;
create policy p_comp_items_write on composition_items for all
  using (
    exists (
      select 1 from compositions c
      where c.id = composition_items.composition_id
        and (c.owner_id = auth.uid() or c.visibility = 'edit')
    )
  )
  with check (
    exists (
      select 1 from compositions c
      where c.id = composition_items.composition_id
        and (c.owner_id = auth.uid() or c.visibility = 'edit')
    )
  );
