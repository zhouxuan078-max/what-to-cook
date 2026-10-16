-- ============================================================================
--  吃什么 · 数据库结构
--  目标：PostgreSQL 12+（在 WorkBuddy 云服务 / Supabase 上验证通过）
--
--  设计要点（不是随手写的，每条都有原因）：
--
--  1. 两张表都开启 RLS，但**不建任何 policy**。
--     RLS 开启 + 无 policy = 默认拒绝，任何非超级用户都读不到一行。
--     所以浏览器端即使拿到 publishable key，也拿不到表里的数据。
--
--  2. 表上虽然给了 anon 的 SELECT 权限（PG 默认行为），但因为没有 policy，
--     实际返回 0 行。真正的读写只走 functions.sql 里那 6 个 SECURITY DEFINER
--     函数，函数内部自己校验凭证（cook_token / share_code）。
--     想更保守，可以把最后那行 GRANT 注释掉 —— 功能不受影响。
--
--  3. cook_token 由浏览器生成并存在本机，是"下厨的人"的唯一凭证；
--     share_code 是给别人用的公开菜单码。两者职责分开，互不推导。
--
--  执行顺序：先本文件，再 functions.sql。
-- ============================================================================


-- ---------------------------------------------------------------------------
--  建表
-- ---------------------------------------------------------------------------

create table if not exists public.kf_kitchens (
  id          bigint      generated always as identity primary key,
  cook_token  text        not null unique,          -- 下厨人的本机密钥，长度 >= 16
  share_code  text        not null unique,          -- 6~8 位菜单码，公开
  cook_name   text        not null default '做菜人',
  title       text        not null default '今晚菜单',
  note        text        not null default '',
  settings    jsonb       not null default '{}'::jsonb,
  ingredients jsonb       not null default '[]'::jsonb,   -- 冰箱里有什么
  dishes      jsonb       not null default '[]'::jsonb,   -- 备选菜品
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  takeouts    jsonb       not null default '[]'::jsonb    -- 外卖/下馆子选项
);

create table if not exists public.kf_orders (
  id          bigint      generated always as identity primary key,
  kitchen_id  bigint      not null
              references public.kf_kitchens(id) on delete cascade,
  guest_token text        not null default '',      -- 点菜人的本机标识，用于区分不同人
  guest_name  text        not null default '食客',
  items       jsonb       not null default '[]'::jsonb,
  message     text        not null default '',
  seen        boolean     not null default false,   -- 下厨的人是否已读
  created_at  timestamptz not null default now()
);

-- 下厨的人按时间倒序拉自己的点单，这个索引对应该查询
create index if not exists kf_orders_kitchen_idx
  on public.kf_orders (kitchen_id, created_at desc);

-- kf_submit_order 每次提交都要先找"这个人在这份菜单上有没有单子"（同一个
-- guest_token 只保留一条，改主意就是更新自己那条）。这个索引对应该查询。
-- 漏了它功能也正常，只是每次提交要多扫一遍点单表。
create index if not exists kf_orders_guest_idx
  on public.kf_orders (kitchen_id, guest_token);


-- ---------------------------------------------------------------------------
--  行级安全：开启，但不建 policy（默认拒绝）
-- ---------------------------------------------------------------------------

alter table public.kf_kitchens enable row level security;
alter table public.kf_orders   enable row level security;

-- 这里**故意什么都不写**。没有 policy，RLS 就是默认全拒。
-- 千万别为了"让它能查"而补一条 using (true) —— 那等于把两张表对公网敞开。


-- ---------------------------------------------------------------------------
--  权限
-- ---------------------------------------------------------------------------

-- 表：不给浏览器任何写权限（连 SELECT 都不需要，因为读也走函数）。
-- 如果托管平台在建表时默认给了 anon 的 SELECT，可以显式收回：
revoke all on public.kf_kitchens from anon, authenticated;
revoke all on public.kf_orders   from anon, authenticated;

-- 函数：这几个是要给前端调的，必须显式授权。
grant execute on function public.kf_upsert_kitchen(text, jsonb)  to anon, authenticated;
grant execute on function public.kf_get_kitchen(text)            to anon, authenticated;
grant execute on function public.kf_get_menu(text)               to anon, authenticated;
grant execute on function public.kf_submit_order(text, text, text, jsonb, text) to anon, authenticated;
grant execute on function public.kf_list_orders(text)            to anon, authenticated;
grant execute on function public.kf_mark_orders_seen(text)       to anon, authenticated;


-- ---------------------------------------------------------------------------
--  关于分享码的唯一性
--
--  share_code 上有 UNIQUE 约束（kf_kitchens_share_code_key），物理上不可能重复。
--  生成逻辑在 kf_upsert_kitchen 里：先从 32 个字符里摇 6 位，
--  每档最多试 500 次；撞满了升 7 位，再升 8 位；仍分配不到才抛 P0003。
--
--  为什么不用无上限的 loop：分享码真的被占满时，无上限循环会让请求
--  永远挂在那里（用户看到的是"转圈转到天荒地老"），而不是干脆失败。
--  ⚠ 32 个字符里没有 I、O、0、1 —— 避免抄菜单码时把 0/O、1/I 认混。
-- ---------------------------------------------------------------------------
