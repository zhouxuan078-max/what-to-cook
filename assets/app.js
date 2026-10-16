/* ==========================================================================
   路由与首页
   ========================================================================== */
window.KF = window.KF || {};
window.KF.state = window.KF.state || { route: { name: 'home' }, cook: null, guest: null };

(function () {
  'use strict';

  const U = window.KF.util;

  const KEY_TOKEN = 'kf_cook_token_v1';
  const KEY_DRAFT = 'kf_cook_draft_v1';

  function parseHash() {
    const raw = (location.hash || '').replace(/^#/, '');
    if (!raw || raw === '/' || raw === '') return { name: 'home', code: '' };
    if (raw === '/cook') return { name: 'cook', code: '' };
    if (raw === '/guest') return { name: 'guest', code: '' };
    const m = raw.match(/^\/m\/([A-Za-z0-9]{1,12})$/);
    if (m) return { name: 'guest', code: m[1].toUpperCase() };
    return { name: 'home', code: '' };
  }

  /* 每次切换路由都换一个全新的容器，避免上一次的监听器残留 */
  function mount(cls) {
    const old = document.getElementById('view');
    const fresh = document.createElement('main');
    fresh.id = 'view';
    if (cls) fresh.className = cls;
    if (old) old.replaceWith(fresh);
    else document.body.appendChild(fresh);
    return fresh;
  }

  function route() {
    const r = parseHash();
    window.KF.state.route = r;

    if (r.name !== 'cook' && window.KF.cook) window.KF.cook.stopPolling();

    if (r.name === 'cook') { renderCook(); return; }
    if (r.name === 'guest') { renderGuest(r.code); return; }
    renderHome();
  }

  /* ---------- 首页 ---------- */

  function hasSavedKitchen() {
    const t = U.store.get(KEY_TOKEN, null);
    const d = U.store.get(KEY_DRAFT, null);
    if (!t) return null;
    if (d && ((d.ingredients || []).length || (d.dishes || []).length)) return d;
    return null;
  }

  function renderHome() {
    const host = mount('');
    const saved = hasSavedKitchen();
    const cookieHint = '';

    let h = '<div class="wrap">';
    h += '<div class="home-hero">' +
         '<h1>吃什么</h1>' +
         '<p>把冰箱里现有的东西填进去，AI 出几道菜，附热量和注意事项。' +
         '挑好发出去，想吃什么的人点完星，你这边就收到。</p>' +
         '</div>';

    h += '<div class="role-grid">';
    h += '<button class="role-card" id="go-cook">' +
         '<div class="em">🍳</div>' +
         '<h3>' + (saved ? '继续安排这一顿' : '我来下厨') + '</h3>' +
         '<p>' + (saved
            ? '你已经存了 ' + (saved.ingredients || []).length + ' 样食材、' +
              (saved.dishes || []).length + ' 道菜，接着改。'
            : '填食材、让 AI 推荐、挑菜、生成菜单码。') + '</p>' +
         '<div class="go">' + (saved ? '接着弄 →' : '开始选菜 →') + '</div>' +
         '</button>';

    h += '<button class="role-card" id="go-guest">' +
         '<div class="em">🍽</div>' +
         '<h3>我来点菜</h3>' +
         '<p>拿到下厨的人发来的那 6 位菜单码，进来挑想吃的、给想吃的程度打个星，提交给他。</p>' +
         '<div class="go">去看菜单 →</div>' +
         '</button>';
    h += '</div>';

    h += '<div class="card" style="margin-top:20px;text-align:center">' +
         '<h3 style="font-size:15px">手上有菜单码？</h3>' +
         '<div class="join-row">' +
           '<input type="text" id="join-code" maxlength="8" placeholder="6 位菜单码">' +
           '<button class="btn btn-primary" id="btn-join">打开菜单</button>' +
         '</div>' +
         '</div>';

    h += '</div>';

    host.innerHTML = h;

    document.getElementById('go-cook').addEventListener('click', function () {
      location.hash = '#/cook';
    });
    document.getElementById('go-guest').addEventListener('click', function () {
      location.hash = '#/guest';
    });
    document.getElementById('btn-join').addEventListener('click', joinFromHome);
  }

  function joinFromHome() {
    const el = document.getElementById('join-code');
    const code = el ? el.value.trim().toUpperCase() : '';
    if (!code) { U.toast('请先输入菜单码', 'err'); return; }
    location.hash = '#/m/' + code;
  }

  /* ---------- 下厨的一侧 ---------- */

  let cookReady = false;

  async function renderCook() {
    const host = mount('wrap');
    host.innerHTML = '<div class="card"><div class="skeleton" style="width:32%;height:20px"></div>' +
                     '<div class="skeleton" style="width:64%"></div>' +
                     '<div class="skeleton" style="width:48%"></div></div>';

    /* 每次进路由都是全新的容器节点，所以监听器要重新挂一次 */
    window.KF.cook.bind(host);

    if (!cookReady) {
      await window.KF.cook.init();
      cookReady = true;
    }
    window.KF.cook.render(host);
  }

  /* ---------- 点菜的一侧 ---------- */

  function renderGuest(code) {
    const host = mount('');
    window.KF.guest.bind(host);
    window.KF.guest.reset(code);
    if (code) window.KF.guest.load(code);
    else window.KF.guest.render(host);
  }

  /* ---------- 启动 ---------- */

  function boot() {
    window.addEventListener('hashchange', route);

    /* 任何没被接住的脚本错误都直接说出来。
       最怕的不是报错，是「点了没反应、又不报错」这种哑失败。 */
    window.addEventListener('error', function (e) {
      const msg = e && e.message ? e.message : '未知错误';
      U.toast('页面出错：' + msg, 'err');
    });
    window.addEventListener('unhandledrejection', function (e) {
      U.toast('操作未完成：' + U.errText(e && e.reason), 'err');
    });

    document.addEventListener('keydown', function (e) {
      if (window.KF.state.route.name === 'cook' && window.KF.cook) window.KF.cook.onKeydown(e);
      if (window.KF.state.route.name === 'guest' && window.KF.guest) window.KF.guest.onKeydown(e);
    });

    document.addEventListener('visibilitychange', function () {
      if (!document.hidden && window.KF.state.route.name === 'cook' && window.KF.cook) {
        window.KF.cook.refreshShareBar();
      }
    });

    window.addEventListener('beforeunload', function () {
      if (window.KF.state.route.name === 'cook' && window.KF.cook) window.KF.cook.saveNow();
    });

    if (!location.hash) {
      const saved = hasSavedKitchen();
      /* replaceState 不会触发 hashchange，避免首屏渲染两次 */
      history.replaceState(null, '', location.pathname + location.search + (saved ? '#/cook' : '#/'));
    }
    route();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
