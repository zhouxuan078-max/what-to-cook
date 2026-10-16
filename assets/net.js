/* ==========================================================================
   在线通道（可选）

   这个站有两条把点单送到下厨的人手上的路：

     ① 离线通道（share.js）：把点单压进链接 / 二维码，对方复制、发微信。
        永远可用，但中间要人手动搬一次。
     ② 在线通道（这个文件）：把点单直接 POST 给站自己那个后端（_worker.js），
        下厨的人那边自动就看到了。

   这里只管 ②，而且只管"能不能用、怎么用"；至于用了以后界面怎么变，
   由 cook.js / guest.js 自己决定。

   ★ 装进安卓安装包以后，② 换了一条腿走路

   网页里 ② 走的是 fetch（同源）。壳里页面在假域名上，相对地址指不到真后端，
   fetch 又跨不过去（后端故意不开 CORS）。所以壳里把请求交给原生代码去发，
   不经浏览器。两边的调用方看到的完全一样：一个 Promise，失败就是 null。
   往下翻到「安卓安装包（壳）里那条路」那一段有完整说明。

   ★ 一条铁规矩：这条通道随时可能不存在

   后端没部署、KV 没绑、正在断网、Cloudflare 抽风 —— 任何一种情况下，
   这里所有函数都必须是**安静地失败**：返回 false / null，绝不抛错、
   绝不弹提示、绝不挡住页面。调用方拿到 false 就退回离线通道，
   用户甚至不知道少了一条路。

   ★ 为什么先 ping 一次

   没配后端的站（比如本地双击打开的、或者传到 GitHub Pages 上的），
   每次开页面都去问一遍点单，会在控制台里刷一屏 404。
   所以进页面先问一次 /api/ping，答案是否就整个会话都不再问。
   ========================================================================== */
window.KF = window.KF || {};

(function () {
  'use strict';

  /* 厨房编号：下厨的人这边一个固定的随机串，会跟着菜单一起发给家人。
     它不是密码（会出现在分享链接里），但够长够随机，别人猜不到，
     也就没法往你家菜单里塞点单。 */
  const KEY_KID = 'kf_kid_v1';

  /* 一次请求最多等这么久。家人那边网络不好时不能一直转圈 ——
     等不到就当他没提交成功，回头走链接那条路。 */
  const TIMEOUT = 6000;

  /* ==========================================================================
     安卓安装包（壳）里那条路
     ==========================================================================

     装进安卓壳以后，页面的来源是壳给的假域名
     `https://appassets.androidplatform.net`（为什么要用假域名，见壳里的注释：
     用 file:// 的话 fetch 和 localStorage 都会被拦掉）。

     于是这里有个岔子：上面那些 `/api/...` 是**相对地址**，在壳里会指到
     壳自己身上去 —— 壳里没有后端，请求必然 404，「自动收单」整条就哑了。
     表现还特别难查：不报错、不弹提示，就是家人提交完，下厨的人那边
     永远等不到。

     那让壳里的 fetch 直接去连真后端行不行？不行。真后端**故意**不返回任何
     CORS 头（见 _worker.js 里「安全边界」那一段，那是拦着别的网站顶着访客
     身份往你家菜单塞点单的）。从假域名跨过去会被浏览器直接拦下。

     所以壳里改走一条**不经浏览器**的路：把请求交给壳的原生代码去发
     （AndroidShell.httpRequest），发完再回调页面。原生发 HTTP 不涉及
     同源策略，CORS 这回事根本不存在 —— 也就不必让后端开这个口子。

     网页那边一个字节都不变：下面这整块在浏览器里不会被走到
     （浏览器里没有 AndroidShell.httpRequest）。 */

  /* 认准 httpRequest 这一个方法，而不是「有没有 AndroidShell」——
     别的壳（比如英语台那个）也挂了 AndroidShell，但只有 saveText，
     拿它当判据会在这里撞上一个 undefined 的函数。 */
  const SHELL = !!(window.AndroidShell &&
                   typeof window.AndroidShell.httpRequest === 'function');

  /* 真后端的绝对地址。只有壳里用得上（网页里是同源，用相对路径）。
     ⚠️ 换了 Cloudflare 项目名 / 换了域名，改这一行，
        同时把安卓工程 README 里那句也改掉，两处要一致。 */
  const API_BASE = SHELL ? 'https://what-to-cook-bi7.pages.dev' : '';

  /* 壳回调的落点。每次请求编一个号，原生做完按号把结果送回来。
     用编号而不是"一次性回调"：轮询 8 秒一次、连点也可能并发，
     不编号就会串台。 */
  const waiters = new Map();
  let seq = 0;

  window.KF_HTTP = {
    /* 壳会调这个：done(id, '{"ok":true,"status":200,"body":"..."}') */
    done: function (id, payload) {
      const w = waiters.get(String(id));
      if (!w) return;
      waiters.delete(String(id));
      clearTimeout(w.timer);

      let env = null;
      try { env = payload ? JSON.parse(payload) : null; } catch (e) { env = null; }
      if (!env || !env.ok || env.status !== 200) { w.resolve(null); return; }
      try { w.resolve(JSON.parse(env.body)); } catch (e) { w.resolve(null); }
    },
  };

  /* 交给壳去发一条请求。壳那边也是"安静地失败"：超时、连不上、
     解析不出来，一律 resolve(null)，调用方只需要判 null。 */
  function reqViaShell(path, opts) {
    const o = opts || {};
    return new Promise(function (resolve) {
      const id = 'r' + (++seq);
      const timer = setTimeout(function () {
        waiters.delete(id);
        resolve(null);
      }, o.timeout || TIMEOUT);
      waiters.set(id, { resolve: resolve, timer: timer });
      try {
        window.AndroidShell.httpRequest(
          id, o.method || 'GET', API_BASE + path, o.body || '');
      } catch (e) {
        waiters.delete(id);
        clearTimeout(timer);
        resolve(null);
      }
    });
  }

  /* 会话级缓存的探测结果：null = 还没问过 */
  let pinged = null;

  function readKid() {
    try {
      const v = window.localStorage.getItem(KEY_KID);
      const t = v == null ? '' : JSON.parse(v);
      return (typeof t === 'string' && /^[A-Za-z0-9_-]{8,40}$/.test(t)) ? t : '';
    } catch (e) { return ''; }
  }

  function writeKid(t) {
    try { window.localStorage.setItem(KEY_KID, JSON.stringify(t)); } catch (e) { /* 隐私模式忽略 */ }
  }

  /* 取（必要时生成）厨房编号。整个过程是同步的 —— menuPayload() 是同步调用的，
     不能让它变成 async 去等一个编号。 */
  function kid() {
    let t = readKid();
    if (t) return t;
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    const buf = new Uint8Array(16);
    if (window.crypto && window.crypto.getRandomValues) {
      window.crypto.getRandomValues(buf);
    } else {
      for (let i = 0; i < 16; i++) buf[i] = Math.floor(Math.random() * 256);
    }
    t = '';
    for (let i = 0; i < 16; i++) t += chars[buf[i] % chars.length];
    writeKid(t);
    return t;
  }

  /* 所有请求走这一个出口。超时、断网、404、返回的不是 JSON ——
     统统变成 null，调用方只需要判 null。 */
  function req(path, opts) {
    const o = opts || {};
    /* 壳里没有"同源后端"这回事（页面在假域名上），整条交给原生去发。 */
    if (SHELL) return reqViaShell(path, o);
    if (typeof window.fetch !== 'function') return Promise.resolve(null);

    let settled = false;
    return new Promise(function (resolve) {
      const timer = setTimeout(function () {
        if (settled) return;
        settled = true;
        resolve(null);
      }, o.timeout || TIMEOUT);

      let p;
      try {
        /* 网页里 API_BASE 是空串，这里就是原来的相对地址，行为不变。 */
        p = window.fetch(API_BASE + path, {
          method: o.method || 'GET',
          headers: o.body ? { 'content-type': 'application/json' } : undefined,
          body: o.body,
          /* 同源请求，但显式说一声别带 cookie、别用缓存 ——
             点单要的是刚刚那一刻的状态。 */
          credentials: 'omit',
          cache: 'no-store',
        });
      } catch (e) {
        clearTimeout(timer);
        settled = true;
        resolve(null);
        return;
      }

      p.then(function (r) {
        if (!r || !r.ok) return null;
        return r.json();
      }).then(function (data) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(data && typeof data === 'object' ? data : null);
      }, function () {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(null);
      });
    });
  }

  /* 这个站到底有没有后端。每个会话只问一次。
     force = true 用来支持界面上的"再试一次"：用户可能是在没网的时候
     打开了页面，后来连上 WiFi 了。 */
  async function ping(force) {
    if (!force && pinged !== null) return pinged;
    const r = await req('/api/ping', { timeout: 4000 });
    /* 必须同时满足两条：返回得是本站后端、而且它那边 KV 是绑好的。
       只部署了 _worker.js 但没绑 KV 的情况，自动收单是跑不起来的，
       那就跟没有后端一样 —— 提前说清楚，别让前端傻等。 */
    pinged = !!(r && r.ok && r.service === 'what-to-cook' && r.kv);
    return pinged;
  }

  function resetPing() { pinged = null; }

  /* 把一条点单交给后端。返回 true 才是真的送到了；
     送不到（返回 false）调用方要照常给出链接和二维码。 */
  async function postOrder(shopId, order) {
    if (!shopId || !order) return false;
    const r = await req('/api/order', {
      method: 'POST',
      body: JSON.stringify({ k: shopId, o: order }),
    });
    return !!(r && r.ok);
  }

  /* 取回这个厨房收到过的点单。返回数组＝拿到了（可能是空数组）；
     返回 null＝这条路走不通。 */
  async function fetchOrders(shopId) {
    if (!shopId) return null;
    const r = await req('/api/orders?k=' + encodeURIComponent(shopId));
    if (!r || !r.ok) return null;
    return Array.isArray(r.orders) ? r.orders : [];
  }

  window.KF.net = {
    kid: kid,
    ping: ping,
    resetPing: resetPing,
    postOrder: postOrder,
    fetchOrders: fetchOrders,
  };
})();
