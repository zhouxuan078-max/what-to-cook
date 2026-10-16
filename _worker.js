/* ==========================================================================
   吃什么 —— 可选的轻后端
   （Cloudflare Pages 的「高级模式」Worker，文件名必须是 _worker.js 且在站点根目录）

   ★ 这个文件和主通道的关系

   这个站的主通道是「数据跟着链接走」（见 assets/share.js）：菜单压进网址、
   点单压进网址，两台手机之间直接传，全程不经过任何服务器。
   那条通道永远不会坏，但代价是——家人点完菜，得把那段内容复制出来、用微信
   发给你，你这边再粘一次。

   这个文件提供**第二条通道**：家人点完直接 POST 到这里，你那边自动就看到了。

   两条通道是「能走第二条就走第二条，走不通就退回第一条」：
   这个文件没部署、或者 KV 没绑上，前端会自己发现（问一次 /api/ping），
   然后安静地退回链接模式——不报错、不白屏、功能一个不少。

   ★ 为什么不继续用 WorkBuddy 那套云服务

   它按「来源域名」做精确校验，而且这个白名单在控制台里改不了。网站一旦被放到
   别的域名上（比如现在这个 Cloudflare 地址），请求就被 403 拒掉。
   自己建这一层就没有这个约束：同源，不可能再报那个错。

   ★ 要用它，需要在 Cloudflare 控制台做两件事（一次性）

   1) 建一个 KV 命名空间（Storage & Databases → KV → Create）
   2) Pages 项目 → Settings → Bindings（老界面叫 Functions）→ 添加 KV 命名空间绑定
      —— 变量名必须一字不差地填：KF_KV

   没绑 KV 也能正常部署，只是「自动收单」这半边不生效，前端会自动退回链接模式。
   ★ 绑定是在「部署」这个层级生效的：加完绑定如果提示需要重新部署，
     点一下 Retry deployment（或把站点再传一次）就行。

   ★ 安全边界

   * 只认同源请求。不返回任何 CORS 头 —— 于是别的网站没法顶着访问者的身份
     往这里塞点单，这是浏览器替我们把的门。
   * 厨房编号（kid）是随机的，会出现在分享链接里，本身不是秘密；但它够长够随机，
     外人猜不到，也就没法往你家菜单里乱塞东西。
   * 每条点单一个键、7 天后自动过期，不会把免费额度堆满。
   ========================================================================== */

const MAX_BODY = 8 * 1024;              /* 一条点单撑死几 KB，超了就是异常流量 */
const MAX_ITEMS = 40;                   /* 一个人一次最多点几样 */
const MAX_ORDERS = 50;                  /* 一次最多回给前端这么多条 */
const ORDER_TTL = 60 * 60 * 24 * 7;     /* 7 天 */
const PREFIX = 'o:';

/* ---------- 小工具 ---------- */

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      /* 点单必须每次都是最新的，任何一层缓存都不能留 */
      'cache-control': 'no-store, no-cache, must-revalidate',
    },
  });
}

/* 切掉控制字符、去掉首尾空白、再限长。
   这些内容会原样显示在下厨的人眼前，长度不限死的话一条点单能把界面撑爆。

   为什么要 trim：不止是为了好看 —— 它还是"这条到底算不算空"的判据。
   不 trim 的话，一个全是空格的名字看上去非空（"   " 是真值），
   于是"只看空格、不点菜"也能存进一条点单，下厨的人打开看到一片空白。 */
function clip(v, n) {
  return String(v == null ? '' : v)
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .trim()
    .slice(0, n);
}

/* 厨房编号会出现在分享链接里，不是秘密—— 但必须够长够随机，
   否则别人能猜到、往你家菜单里塞点单。 */
function okKid(k) {
  return typeof k === 'string' && /^[A-Za-z0-9_-]{8,40}$/.test(k);
}

function keyOf(kid, atMs, id) {
  /* 时间戳补够位（纯数字、定长），这样同一个厨房下的键天然按时间排序，
     万一以后要翻页也不会乱。 */
  const t = String(Math.max(0, Math.floor(atMs))).padStart(14, '0');
  return PREFIX + kid + ':' + t + ':' + String(id).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 20);
}

/* 一条点单的净化。字段跟前端 items 结构一一对应，多余的一律丢掉 ——
   别人可以直接 POST 任何东西过来，不能原样存、更不能原样回。 */
function cleanOrder(src) {
  const o = (src && typeof src === 'object') ? src : {};

  const items = (Array.isArray(o.items) ? o.items : []).slice(0, MAX_ITEMS).map(function (it) {
    const x = (it && typeof it === 'object') ? it : {};
    const kind = (x.kind === 'takeout' || x.kind === 'wish') ? x.kind : '';
    return {
      name: clip(x.name, 40),
      stars: Math.max(0, Math.min(5, Math.round(Number(x.stars) || 0))),
      kind: kind,
      from: clip(x.from, 40),
      where: clip(x.where, 40),
      price: clip(x.price, 16),
      note: clip(x.note, 80),
      /* 这条是"下厨的人自己摆出来的外卖选项被勾了"，还是"家人自己写的"，
         下厨端要靠这个区分，别丢了。 */
      offered_by_cook: x.offered_by_cook === true,
    };
  }).filter(function (it) { return it.name; });

  const at = clip(o.at, 40) || new Date().toISOString();
  /* id 用来去重：同一条链接在微信里点第二次不能变成两条。
     前端一定会给，这里只是兜底。 */
  const id = clip(o.id, 40).replace(/[^A-Za-z0-9_-]/g, '') ||
             (Date.now().toString(36) + Math.random().toString(36).slice(2, 8));

  return {
    id: id,
    at: at,
    guest: clip(o.guest, 24) || '匿名',
    items: items,
    message: clip(o.message, 200),
    server_at: new Date().toISOString(),
  };
}

/* 从 KV 键名里把写入时刻抠出来。值被写坏时还要靠它排序，
   所以不能只依赖 JSON 里的 at。 */
function msOfKey(key) {
  const m = /:(\d{14}):/.exec(String(key));
  return m ? Number(m[1]) : 0;
}

/* ---------- 接口 ---------- */

/* 后端到底有没有、KV 到底绑没绑。前端进页面先问一次，
   返回 false 就整个不轮询了 —— 免得每次开页面白问一堆 404。 */
function apiPing(env) {
  return json({
    ok: true,
    service: 'what-to-cook',
    kv: !!(env && env.KF_KV),
    at: new Date().toISOString(),
  });
}

async function apiPostOrder(request, env) {
  const kv = env && env.KF_KV;
  if (!kv) return json({ ok: false, reason: 'no-kv' });

  /* 先卡长度再读，别让人用一个超大 body 把 Worker 拖住 */
  const len = Number(request.headers.get('content-length') || 0);
  if (len > MAX_BODY) return json({ ok: false, reason: 'too-large' });

  let body;
  try {
    const text = await request.text();
    if (text.length > MAX_BODY) return json({ ok: false, reason: 'too-large' });
    body = JSON.parse(text);
  } catch (e) {
    return json({ ok: false, reason: 'bad-json' });
  }

  const kid = body && body.k;
  if (!okKid(kid)) return json({ ok: false, reason: 'bad-kid' });

  const order = cleanOrder(body.o);
  if (!order.items.length) return json({ ok: false, reason: 'empty' });

  try {
    await kv.put(keyOf(kid, Date.now(), order.id), JSON.stringify(order), {
      expirationTtl: ORDER_TTL,
    });
  } catch (e) {
    return json({ ok: false, reason: 'kv-write-failed' });
  }

  return json({ ok: true, id: order.id });
}

async function apiListOrders(url, env) {
  const kv = env && env.KF_KV;
  if (!kv) return json({ ok: false, reason: 'no-kv' });

  const kid = url.searchParams.get('k') || '';
  if (!okKid(kid)) return json({ ok: false, reason: 'bad-kid' });

  const prefix = PREFIX + kid + ':';

  /* 用 list 而不是"读一个大数组再往里塞"：list 是强一致的，
     家人刚提交的立刻就能列出来；而且没有"读-改-写"的竞态 ——
     两个人同时提交也不会有一条被覆盖掉。 */
  let keys = [];
  let cursor = null;
  for (let page = 0; page < 4; page++) {
    const res = await kv.list({ prefix: prefix, cursor: cursor, limit: 1000 });
    keys = keys.concat(res.keys || []);
    cursor = res.list_complete ? null : res.cursor;
    if (!cursor) break;
  }

  /* 只要最新的那些。键名里带着定长时间戳，所以先按名字排就够了，
     不用把每个值都读出来再比时间。 */
  keys.sort(function (a, b) { return String(a.name) < String(b.name) ? 1 : -1; });
  const pick = keys.slice(0, MAX_ORDERS);

  let values = [];
  if (pick.length) {
    const names = pick.map(function (k) { return k.name; });
    try {
      /* 批量读：一次调用把 50 个键全取回来，比逐个 get 少 49 次往返 */
      const map = await kv.get(names);
      values = names.map(function (n) { return map ? map.get(n) : null; });
    } catch (e) {
      /* 老版本运行时可能不支持数组形式，退回逐个读 */
      values = await Promise.all(names.map(function (n) {
        return kv.get(n).catch(function () { return null; });
      }));
    }
  }

  const orders = [];
  for (let i = 0; i < pick.length; i++) {
    const raw = values[i];
    if (!raw) continue;
    try {
      const o = JSON.parse(raw);
      if (o && Array.isArray(o.items)) orders.push(o);
    } catch (e) { /* 这一条坏了就跳过，不能让整次读取失败 */ }
  }

  return json({ ok: true, count: orders.length, orders: orders });
}

/* ---------- 入口 ---------- */

export default {
  async fetch(request, env) {
    let url;
    try {
      url = new URL(request.url);
    } catch (e) {
      return new Response('bad request', { status: 400 });
    }

    const path = url.pathname;

    if (path === '/api/ping') return apiPing(env);
    if (path === '/api/order') {
      if (request.method !== 'POST') return json({ ok: false, reason: 'method' }, 405);
      return apiPostOrder(request, env);
    }
    if (path === '/api/orders') {
      if (request.method !== 'GET') return json({ ok: false, reason: 'method' }, 405);
      return apiListOrders(url, env);
    }
    if (path.indexOf('/api/') === 0) return json({ ok: false, reason: 'not-found' }, 404);

    /* 静态文件交给 Pages 自己发。
       正常部署时 _routes.json 已经把非 /api/ 的请求挡在门外、根本走不到这里，
       这段是兜底：万一那层没生效，站点也不会整个打不开。 */
    if (env && env.ASSETS && typeof env.ASSETS.fetch === 'function') {
      return env.ASSETS.fetch(request);
    }
    return new Response('Not found', { status: 404 });
  },
};
