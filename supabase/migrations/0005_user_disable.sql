-- ============================================================
-- 0005：停用用户（封禁）状态位
--
-- 配套管理端「云端管理 → 权限管理」的停用/启用按钮：
--   1) profiles.is_active 标记 UI 状态
--   2) 真正禁止登录由后端调用 GoTrue admin API（ban_duration）完成：
--      停用 → PUT /auth/v1/admin/users/{id} {"ban_duration": "876000h"}
--      启用 → PUT /auth/v1/admin/users/{id} {"ban_duration": "0s"}
--      被封禁账号无法登录、刷新令牌失效；网页端加载 profile 时
--      若 is_active = false 也会主动登出（双保险）。
-- ============================================================

alter table profiles
  add column if not exists is_active boolean not null default true;
