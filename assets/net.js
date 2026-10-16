/* ==========================================================================
   在线通道（可选）

   这个站有两条把点单送到下厨的人手上的路：

     ① 离线通道（share.js）：把点单压进链接 / 二维码，对方复制、发微信。
        永远可用，但中间要人手动搬一次。
     ② 在线通道（这个文件）：把点单直接 POST 给站自己那个后端（_worker.js），
        下厨的人那边自动就看到了。

   这里只管 ②，而且只管"能不能用、怎么用"；至于用了以后界面怎么变，
   由 cook.js / guest.js 自己决定。

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
        p = window.fetch(path, {
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
