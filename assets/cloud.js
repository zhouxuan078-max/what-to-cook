/* ==========================================================================
   云端访问层
   全部读写都走服务端函数；数据表本身对浏览器关闭。
   ========================================================================== */
window.KF = window.KF || {};

(function () {
  'use strict';

  const cfg = window.KF.config;
  let _client = null;

  /* 全局唯一实例：所有模块复用同一个客户端 */
  function client() {
    if (_client) return _client;
    const NS = window.WorkBuddyCloud;
    if (!NS || typeof NS.createWorkBuddyCloud !== 'function') {
      throw new Error('云服务组件未加载完成，请检查网络后刷新页面。');
    }
    _client = NS.createWorkBuddyCloud({
      endpoint: cfg.endpoint,
      publishableKey: cfg.publishableKey,
    });
    return _client;
  }

  async function rpc(fn, args) {
    const res = await client().database.rpc(fn, args || {});
    if (res && res.error) throw res.error;
    return res ? res.data : null;
  }

  window.KF.api = {
    client: client,
    rpc: rpc,

    /* 下厨的人：写入/更新整份厨房数据（首个参数是本机密钥，服务端据此判定归属） */
    upsertKitchen: function (cookToken, payload) {
      return rpc('kf_upsert_kitchen', { p_cook_token: cookToken, p_payload: payload });
    },
    getKitchen: function (cookToken) {
      return rpc('kf_get_kitchen', { p_cook_token: cookToken });
    },

    /* 点菜的人：凭菜单码读菜单 */
    getMenu: function (code) {
      return rpc('kf_get_menu', { p_share_code: code });
    },
    submitOrder: function (o) {
      return rpc('kf_submit_order', {
        p_share_code: o.code,
        p_guest_token: o.guestToken || '',
        p_guest_name: o.guestName || '匿名',
        p_items: o.items || [],
        p_message: o.message || '',
      });
    },

    /* 下厨的人：读点单 / 标记已读 */
    listOrders: function (cookToken) {
      return rpc('kf_list_orders', { p_cook_token: cookToken });
    },
    markOrdersSeen: function (cookToken) {
      return rpc('kf_mark_orders_seen', { p_cook_token: cookToken });
    },
  };
})();
