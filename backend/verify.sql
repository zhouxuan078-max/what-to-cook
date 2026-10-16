-- ============================================================================
--  部署后自检 · 只读，不会改任何数据
--
--  用法：把本文件整个粘进云服务的管理台（或 SQL 编辑器）跑一遍，
--        逐段看结果。每段后面写了"期望看到什么"。
--
--  改过 functions.sql 之后建议跑这个，而不是靠感觉判断"应该生效了吧"。
-- ============================================================================


-- ---------------------------------------------------------------------------
-- 1. 六个函数是不是都在
--    期望：6 行，函数名和下面列的一模一样
--    少一个就说明 functions.sql 没跑完（或中途报错了）
-- ---------------------------------------------------------------------------
select p.proname as 函数名
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public'
   and p.proname in ('kf_upsert_kitchen','kf_get_kitchen','kf_get_menu',
                     'kf_submit_order','kf_list_orders','kf_mark_orders_seen')
 order by p.proname;


-- ---------------------------------------------------------------------------
-- 2. kf_submit_order 里确实有"认人"的那段逻辑
--    期望：一行，且 命中 为 true
--    这是在函数源码里搜 guest_token —— 因为 CREATE OR REPLACE 是整段替换，
--    能搜到就说明新版确实覆盖上去了，不是还留着旧版
-- ---------------------------------------------------------------------------
select p.proname as 函数名,
       (pg_get_functiondef(p.oid) like '%guest_token = v_gt%') as 命中
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public'
   and p.proname = 'kf_submit_order';


-- ---------------------------------------------------------------------------
-- 3. 历史遗留的重复点单
--    期望：0 行
--
--    ⚠️ 新版只拦"以后"的重复，**不会**回头合并已经存在的。
--       如果你在部署之前自己测过、留下过重复，这段就会列出它们。
--       真要清理，先自己确认哪条该留（一般是 created_at 最大的那条），
--       别直接照抄一段 DELETE 就跑。本文件故意不提供删除语句。
-- ---------------------------------------------------------------------------
select o.kitchen_id      as 菜单id,
       count(*)          as 点单条数,
       min(o.guest_name) as 点单人,
       max(o.created_at) as 最近一次
  from public.kf_orders o
 where o.guest_token <> ''
 group by o.kitchen_id, o.guest_token
having count(*) > 1
 order by count(*) desc;


-- ---------------------------------------------------------------------------
-- 4. 支撑查重的索引在不在
--    期望：1 行 kf_orders_guest_idx
--    没有也不影响功能（只是每次提交多扫一遍点单表），
--    想补就跑一下 schema.sql 里那句 create index if not exists。
-- ---------------------------------------------------------------------------
select indexname as 索引名
  from pg_indexes
 where schemaname = 'public'
   and indexname = 'kf_orders_guest_idx';


-- ---------------------------------------------------------------------------
-- 5. 点单总量，用来对照"有没有被人刷"
--    期望：数量跟你们家实际吃饭的人数在一个量级
--    异常偏大就说明菜单码被转到不该去的地方了
--    注：guest_token 为空的行是老客户端 / 不带标识提交的，它们本来就是一条一次
-- ---------------------------------------------------------------------------
select
  (select count(*) from public.kf_orders) as 全部点单,
  (select count(*) from public.kf_orders
    where guest_token = '')               as 无标识的,
  (select count(distinct kitchen_id) from public.kf_orders) as 涉及几份菜单,
  (select count(*) from (
     select distinct kitchen_id, guest_token
       from public.kf_orders
      where guest_token <> '') t)         as 有标识的独立人数;
