/* ==========================================================================
   路由与首页
   ========================================================================== */
window.KF = window.KF || {};
window.KF.state = window.KF.state || { route: { name: 'home' }, cook: null, guest: null };

(function () {
  'use strict';

  const U = window.KF.util;
  const SH = window.KF.share;

  const KEY_TOKEN = 'kf_cook_token_v1';
  const KEY_DRAFT = 'kf_cook_draft_v1';

  function parseHash() {
    const raw = (location.hash || '').replace(/^#/, '');
    if (!raw || raw === '/' || raw === '') return { name: 'home', code: '' };
    if (raw === '/cook') return { name: 'cook', code: '' };
    if (raw === '/guest') return { name: 'guest', code: '' };
    /* 菜单载荷：~ 开头的 base64url，可能一千多字符，所以这里不能限长度。
       旧的 6 位菜单码也走这条 —— 由点菜端给出"现在不用了"的说明。
       千万不能 toUpperCase：载荷里的大小写是有意义的。 */
    const m = raw.match(/^\/m\/(.+)$/);
    if (m) return { name: 'guest', code: m[1] };
    /* 家人发来的点单链接：打开这条链接就是把那条点单收下来 */
    const o = raw.match(/^\/o\/(.+)$/);
    if (o) return { name: 'receive', payload: o[1] };
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
    if (r.name === 'receive') { renderReceive(r.payload); return; }
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
         /* 没存过东西时这里不写字 —— 标题和按钮已经说清了 */
         (saved
            ? '<p>你已经存了 ' + (saved.ingredients || []).length + ' 样食材、' +
              (saved.dishes || []).length + ' 道菜，接着改。</p>'
            : '') +
         '<div class="go">' + (saved ? '接着弄 →' : '开始选菜 →') + '</div>' +
         '</button>';

    h += '<button class="role-card" id="go-guest">' +
         '<div class="em">🍽</div>' +
         '<h3>我来点菜</h3>' +
         '<div class="go">去看菜单 →</div>' +
         '</button>';
    h += '</div>';

    h += '<div class="card" style="margin-top:20px;text-align:center">' +
         '<h3 style="font-size:15px">手上已经有菜单了？</h3>' +
         '<div class="join-row">' +
           '<input type="text" id="join-code" placeholder="粘贴链接，或他发来的那段内容">' +
           '<button class="btn btn-primary" id="btn-join">打开菜单</button>' +
         '</div>' +
         '</div>';

    /* 装成 App 的入口。
       ★ 动手改这段之前，先把下面四条读一遍 —— 每条都是别人踩过的坑：
       1. 只能是**链接**。不许 location.href 跳、不许脚本去触发下载。
          页面一打开就往人手机里塞文件，谁看了都会当成流氓站，这是最要紧的一条。
       2. 放在首页正文里，不当浮层、不弹窗、进去不自动展开。
          要装的人自己找得到就行，不想装的人不该被打扰。
       3. 壳里不显示。判据取 window.KF.net.inShell —— 这个判断全站只有
          net.js 那一处，别在这儿再照写一遍「有没有 AndroidShell」：
          英语台那个壳也挂了 AndroidShell，这么写会把网页版误判成 App 里。
       4. net.js 没加载成功时（理论上不会）按"在网页里"处理 —— 宁可多显示
          一个链接，也不要让人想装却没处点。 */
    if (!window.KF.net || !window.KF.net.inShell) {
      h += '<div class="card" style="text-align:center">' +
           '<h3 style="font-size:15px">想在手机桌面上点开就用？</h3>' +
           '<div class="btn-row" style="justify-content:center;margin-top:12px">' +
             '<a class="btn" href="https://github.com/zhouxuan078-max/what-to-cook/releases/latest/download/WhatToCook.apk">下载安卓安装包</a>' +
           '</div>' +
           '<div class="hint" style="margin:11px auto 0;max-width:460px">' +
             /* 这两句之间必须手动断行。让浏览器自己折的话，在 500px 上下
                会折成三行、末行只剩「可。」两个字，很难看 —— 而且窗口宽度
                一变就在两行/三行之间跳。断在这里，任何宽度都齐整。 */
             '约 0.5 MB，只对<b>安卓手机</b>有用 —— iPhone 和电脑上直接用网页就行。<br>' +
             '没上应用商店，安装时可能提示「未知来源」，允许一次即可。' +
           '</div>' +
           '</div>';
    }

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
    /* 粘进来的可能是整条链接、一整段话，也可能只是旧码 —— 交给 share 层去认。
       这里绝不能 toUpperCase，那会把载荷里的大小写弄坏。 */
    const code = SH.codeFrom(el ? el.value : '');
    if (!code) { U.toast('先把下厨的人发来的那条内容粘进来', 'err'); return; }
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

  /* ---------- 收到点单 ---------- */

  /* 家人发来的那条链接长这样：#/o/~1xxxx…
     打开它不该是"看一个页面"，而应该是"把这条点单收进下厨工作台"。
     所以：先把状态建起来、把它收下，然后立刻把地址换回 #/cook ——
     那条长网址要是留在地址栏里，随手一刷新就会又收一条。 */
  async function renderReceive(payload) {
    const host = mount('wrap');
    host.innerHTML = '<div class="card">' +
      '<div class="skeleton" style="width:45%;height:20px"></div>' +
      '<p class="small muted" style="margin:14px 0 0">正在读取这条点单…</p></div>';

    try {
      await window.KF.cook.init();
      await window.KF.cook.receive(payload, false);
    } catch (e) {
      U.toast('读取这条点单失败：' + U.errText(e), 'err');
    }
    location.replace(location.pathname + location.search + '#/cook');
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
      if (document.hidden) return;
      if (window.KF.state.route.name !== 'cook' || !window.KF.cook) return;
      window.KF.cook.refreshShareBar();
      /* 轮询在页面切到后台时会跳过（省流量也省电），所以切回来的这一刻
         要立刻补问一次 —— 不然人切回来还得再等一个周期才看到新点单。 */
      window.KF.cook.wake();
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
