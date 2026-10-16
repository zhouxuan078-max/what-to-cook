-- ============================================================================
--  吃什么 · 服务端函数（6 个）
--
--  全部是 SECURITY DEFINER：以函数属主的身份执行，绕过 RLS，
--  所以在函数内部**必须自己校验凭证** —— 这是这套设计成立的前提。
--  前端拿不到表，只能调这几个函数；函数决定给它什么、不给什么。
--
--  凭证模型：
--    · cook_token  —— 下厨的人的本机密钥（>= 16 字符）。拿着它才能改自己的厨房、
--                     才能读自己收到的点单。**它绝不出现在给别人看的菜单里**。
--    · share_code  —— 公开菜单码。拿着它只能读到"该给人看的那部分"。
--
--  执行顺序：先 schema.sql，再本文件。
-- ============================================================================


-- ---------------------------------------------------------------------------
--  1. 建厨房 / 更新厨房（下厨的人）
--     第一次调用时分配一个没被占用的分享码；之后调用只更新内容。
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.kf_upsert_kitchen(p_cook_token text, p_payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_code text;
  v_row public.kf_kitchens;
  v_len int;
BEGIN
  -- 密钥太短直接拒。前端生成的是长随机串，长度本身就是一道门槛。
  IF p_cook_token IS NULL OR length(p_cook_token) < 16 THEN
    RAISE EXCEPTION 'invalid cook token';
  END IF;

  SELECT * INTO v_row FROM public.kf_kitchens WHERE cook_token = p_cook_token;

  IF NOT FOUND THEN
    -- 分配分享码：6 位每档试 500 次，撞满升 7 位、再 8 位。
    -- 有上限是关键：无上限的话，码真的被占满时请求会永远挂着。
    FOR v_len IN 6..8 LOOP
      FOR i IN 1..500 LOOP
        SELECT string_agg(substr('ABCDEFGHJKLMNPQRSTUVWXYZ23456789', 1 + floor(random() * 32)::int, 1), '')
          INTO v_code
          FROM generate_series(1, v_len);
        EXIT WHEN v_code IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM public.kf_kitchens WHERE share_code = v_code);
        v_code := NULL;
      END LOOP;
      EXIT WHEN v_code IS NOT NULL;
      v_code := NULL;
    END LOOP;

    IF v_code IS NULL THEN
      RAISE EXCEPTION 'could not allocate a share code' USING ERRCODE = 'P0003';
    END IF;

    INSERT INTO public.kf_kitchens
      (cook_token, share_code, cook_name, title, note, settings, takeouts, ingredients, dishes)
    VALUES (
      p_cook_token, v_code,
      coalesce(nullif(btrim(coalesce(p_payload->>'cook_name','')), ''), '下厨的人'),
      coalesce(nullif(btrim(coalesce(p_payload->>'title','')), ''), '今天的菜单'),
      coalesce(p_payload->>'note', ''),
      coalesce(p_payload->'settings', '{}'::jsonb),
      coalesce(p_payload->'takeouts', '[]'::jsonb),
      coalesce(p_payload->'ingredients', '[]'::jsonb),
      coalesce(p_payload->'dishes', '[]'::jsonb)
    ) RETURNING * INTO v_row;
  ELSE
    -- 部分更新：payload 里没给的字段保持原值（coalesce 到旧值）。
    -- 这一点很重要 —— 否则前端只提交一个字段时会把其它字段清空。
    UPDATE public.kf_kitchens
       SET cook_name = coalesce(nullif(btrim(coalesce(p_payload->>'cook_name','')), ''), cook_name),
           title = coalesce(nullif(btrim(coalesce(p_payload->>'title','')), ''), title),
           note = coalesce(p_payload->>'note', note),
           settings = coalesce(p_payload->'settings', settings),
           takeouts = coalesce(p_payload->'takeouts', takeouts),
           ingredients = coalesce(p_payload->'ingredients', ingredients),
           dishes = coalesce(p_payload->'dishes', dishes),
           updated_at = now()
     WHERE cook_token = p_cook_token
     RETURNING * INTO v_row;
  END IF;

  RETURN jsonb_build_object(
    'id', v_row.id, 'share_code', v_row.share_code,
    'cook_name', v_row.cook_name, 'title', v_row.title, 'note', v_row.note,
    'settings', v_row.settings, 'takeouts', v_row.takeouts,
    'ingredients', v_row.ingredients,
    'dishes', v_row.dishes, 'updated_at', v_row.updated_at);
END;
$function$;


-- ---------------------------------------------------------------------------
--  2. 读厨房（下厨的人，用于跨设备恢复）
--     注意返回里带了 order_count / unseen_count —— 前端用它显示未读角标。
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.kf_get_kitchen(p_cook_token text)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
SELECT jsonb_build_object(
  'id', k.id,
  'share_code', k.share_code,
  'cook_name', k.cook_name,
  'title', k.title,
  'note', k.note,
  'settings', k.settings,
  'takeouts', coalesce(k.takeouts, '[]'::jsonb),
  'ingredients', k.ingredients,
  'dishes', k.dishes,
  'updated_at', k.updated_at,
  'order_count',  (SELECT count(*) FROM public.kf_orders o WHERE o.kitchen_id = k.id),
  'unseen_count', (SELECT count(*) FROM public.kf_orders o WHERE o.kitchen_id = k.id AND o.seen = false))
  FROM public.kf_kitchens k
 WHERE k.cook_token = p_cook_token
   AND length(p_cook_token) >= 16
$function$;


-- ---------------------------------------------------------------------------
--  3. 凭菜单码读菜单（点菜的人）—— 这是**唯一的公开读入口**
--
--     刻意只返回该给人看的东西：
--       · 不带 cook_token（否则拿到菜单码的人就能冒充下厨的人）
--       · 不带 id、不带 settings 全量
--       · dishes / takeouts 只回 selected != false 的条目
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.kf_get_menu(p_share_code text)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
SELECT jsonb_build_object(
  'title', k.title,
  'cook_name', k.cook_name,
  'note', k.note,
  'allow_missing', coalesce((k.settings->>'allow_missing')::int, 0),
  'matches_all', coalesce((k.settings->>'matches_all')::boolean, true),
  'people', coalesce(k.settings->>'people', ''),
  'takeouts', coalesce((
     SELECT jsonb_agg(t ORDER BY t->>'shop', t->>'item')
       FROM jsonb_array_elements(coalesce(k.takeouts, '[]'::jsonb)) AS t
      WHERE coalesce((t->>'selected')::boolean, true) = true
        AND (coalesce(t->>'shop','') <> '' OR coalesce(t->>'item','') <> '')
   ), '[]'::jsonb),
  'dishes', coalesce((
     SELECT jsonb_agg(d ORDER BY d->>'name')
       FROM jsonb_array_elements(k.dishes) AS d
      WHERE coalesce((d->>'selected')::boolean, true) = true
   ), '[]'::jsonb),
  'updated_at', k.updated_at)
  FROM public.kf_kitchens k
 WHERE upper(k.share_code) = upper(btrim(coalesce(p_share_code, '')))
$function$;


-- ---------------------------------------------------------------------------
--  4. 提交点单（点菜的人）
--     校验全在这里：菜单码存在吗、点了几道、字段有多长。
--     长度上限是防止有人塞超长文本把数据库顶爆。
--
--     **同一个人对同一份菜单只保留一条点单**（见下面 v_existing 那段）：
--     点菜的人本来就有 guest_token（浏览器本地生成的 24 字节随机串），
--     所以能认出"还是他"。再提交就是**更新自己那条**，不是插一条新的。
--
--     为什么这么做，两个理由：
--       1) 体验。原本他改主意再提交，下厨的人会看到两条几乎一样的点单，
--          分不清哪条算数。现在永远只有一条，就是最新那份。
--       2) 防刷。菜单码是公开的，谁拿到都能提交。没有这一层的话，一个人
--          狂点就能往别人的「收到的点单」里灌几千条 —— 而这条链路是
--          **没有限流**的。有了它，一个人最多占一行。
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.kf_submit_order(p_share_code text, p_guest_token text, p_guest_name text, p_items jsonb, p_message text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_k public.kf_kitchens;
  v_o public.kf_orders;
  v_gt text;
  v_existing bigint;
  v_updated boolean := false;
BEGIN
  SELECT * INTO v_k FROM public.kf_kitchens
   WHERE upper(share_code) = upper(btrim(coalesce(p_share_code, '')));

  IF NOT FOUND THEN
    RAISE EXCEPTION 'menu not found' USING ERRCODE = 'P0002';
  END IF;

  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'empty order' USING ERRCODE = 'P0001';
  END IF;

  IF jsonb_array_length(p_items) > 60 THEN
    RAISE EXCEPTION 'too many items' USING ERRCODE = 'P0001';
  END IF;

  v_gt := left(coalesce(p_guest_token, ''), 64);

  -- guest_token 为空就不认人（老客户端、或有人故意不带），退回"每次都插一条"，
  -- 宁可重复也不能把两个不同的人认成同一个。
  IF v_gt <> '' THEN
    SELECT o.id INTO v_existing
      FROM public.kf_orders o
     WHERE o.kitchen_id = v_k.id
       AND o.guest_token = v_gt
     ORDER BY o.created_at DESC
     LIMIT 1;
  END IF;

  IF v_existing IS NOT NULL THEN
    UPDATE public.kf_orders
       SET guest_name = left(coalesce(nullif(btrim(coalesce(p_guest_name, '')), ''), '食客'), 40),
           items      = p_items,
           message    = left(coalesce(p_message, ''), 500),
           -- 改单之后要重新"未读"，否则下厨的人不会注意到他改了
           seen       = false,
           -- 顺着 created_at 排到最上面：下厨端按 created_at desc 列出点单，
           -- 一条被改过的单子应该回到顶部，而不是留在原来的位置
           created_at = now()
     WHERE id = v_existing
     RETURNING * INTO v_o;
    v_updated := true;
  ELSE
    INSERT INTO public.kf_orders (kitchen_id, guest_token, guest_name, items, message)
    VALUES (v_k.id,
            v_gt,
            left(coalesce(nullif(btrim(coalesce(p_guest_name, '')), ''), '食客'), 40),
            p_items,
            left(coalesce(p_message, ''), 500))
    RETURNING * INTO v_o;
  END IF;

  RETURN jsonb_build_object(
    'id', v_o.id,
    'created_at', v_o.created_at,
    -- 前端据此把提示语分成"已提交"和"已更新你那份点单"两句
    'updated', v_updated);
END;
$function$;


-- ---------------------------------------------------------------------------
--  5. 读自己收到的点单（下厨的人）
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.kf_list_orders(p_cook_token text)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
SELECT coalesce(jsonb_agg(jsonb_build_object(
         'id', o.id,
         'guest_name', o.guest_name,
         'items', o.items,
         'message', o.message,
         'seen', o.seen,
         'created_at', o.created_at) ORDER BY o.created_at DESC), '[]'::jsonb)
  FROM public.kf_orders o
  JOIN public.kf_kitchens k ON k.id = o.kitchen_id
 WHERE k.cook_token = p_cook_token
   AND length(p_cook_token) >= 16
$function$;


-- ---------------------------------------------------------------------------
--  6. 标记点单已读（下厨的人）
--     返回更新了几条，前端据此把未读角标清零。
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.kf_mark_orders_seen(p_cook_token text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_n int;
BEGIN
  UPDATE public.kf_orders o
     SET seen = true
    FROM public.kf_kitchens k
   WHERE k.id = o.kitchen_id
     AND k.cook_token = p_cook_token
     AND length(p_cook_token) >= 16
     AND o.seen = false;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN jsonb_build_object('updated', v_n);
END;
$function$;
