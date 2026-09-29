# Supabase 反代 Worker

国内访问 `*.supabase.co` 不稳时的备用入口。前端探活失败后自动把 `VITE_SUPABASE_URL` 切到 `https://cf.paperlabeler.de5.net`。

## 作用

- 路径原样转发：`/auth/v1/*`、`/rest/v1/*`、`/storage/v1/*`、`/functions/v1/*`、`/realtime/v1/*`
- 其它路径 404（防开放代理）
- 补 CORS（前端从 `paperlabeler.pages.dev` / `paperlabeler.de5.net` 跨域调用）
- 自定义域 `cf.paperlabeler.de5.net`（不要用 `*.workers.dev`）

## 部署

```powershell
cd sb-proxy
npx wrangler deploy
```

首次绑自定义域时，若账号 token 无 DNS 写权限，去 Cloudflare → zone `paperlabeler.de5.net` 手动加：

| 类型 | 名称 | 目标 |
|------|------|------|
| CNAME | `cf` | `paperlabeler-sb-proxy.<account>.workers.dev` |

（或按 wrangler 输出的 custom domain 提示操作。）

## 验证

```powershell
curl.exe -I https://cf.paperlabeler.de5.net/health
curl.exe -I https://cf.paperlabeler.de5.net/auth/v1/health
```

两者都应 200。前端无需改接口代码，只认 `VITE_SUPABASE_URL` / `VITE_SUPABASE_PROXY_URL`。

## 前端配置

| 变量 | 含义 |
|------|------|
| `VITE_SUPABASE_URL` | 直连主地址（默认 Supabase 官方域） |
| `VITE_SUPABASE_PROXY_URL` | 反代备用地址（`https://cf.paperlabeler.de5.net`） |

启动时按「上次成功地址 → 主地址 → 反代」探活 `/auth/v1/health`，选通的建 `supabase-js` 客户端；结果写入 `localStorage`，下次优先用上次成功的。
