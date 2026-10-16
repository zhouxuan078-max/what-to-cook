/* ==========================================================================
   下厨工作台
   ========================================================================== */
window.KF = window.KF || {};

(function () {
  'use strict';

  const U = window.KF.util;
  const API = window.KF.api;
  const AI = window.KF.ai;

  const CATEGORIES = ['蔬菜', '肉禽', '水产', '蛋奶', '豆制品', '主食', '菌菇', '水果', '香料', '调味', '其他'];
  const SPICE_CATS = ['香料', '调味'];

  const QUICK_ADD = [
    '番茄', '鸡蛋', '土豆', '青椒', '洋葱', '五花肉', '鸡腿肉', '牛腩', '虾仁',
    '北豆腐', '香菇', '大白菜', '胡萝卜', '西兰花', '黄瓜', '茄子', '粉丝',
    '面条', '大米', '生抽', '老抽', '蚝油', '料酒', '花椒', '八角', '干辣椒',
    '蒜', '姜', '小葱', '香菜', '豆瓣酱', '番茄酱',
  ];

  const KEY_TOKEN = 'kf_cook_token_v1';
  const KEY_DRAFT = 'kf_cook_draft_v1';
  const KEY_TAB = 'kf_cook_tab_v1';

  let pollTimer = null;
  let lastUnseen = 0;
  let lastOrdersSig = '';
  let stateTicker = null;

  function cs() { return window.KF.state.cook; }

  /* ---------- 生命周期 ---------- */

  function ensureToken() {
    const s = cs();
    if (s.cookToken) return s.cookToken;
    let t = U.store.get(KEY_TOKEN, null);
    if (!t || String(t).length < 16) {
      t = U.randToken(32);
      U.store.set(KEY_TOKEN, t);
    }
    s.cookToken = t;
    return t;
  }

  function emptyState() {
    return {
      loaded: false,
      cookToken: '',
      cookName: '',
      title: '今天的菜单',
      note: '',
      settings: {
        matchesAll: true, allowMissing: 0, people: '2', avoid: '', useBasePantry: true,
        /* meal === '' 表示"让 AI 按当前时间自己判断"，不是"没设置" */
        meal: '', mealCustom: '',
      },
      /* 下厨的人自己提供的外卖 / 下馆子选项。点菜端会看到这一块，
         可以直接勾。空数组＝他这顿不打算点外卖。 */
      takeouts: [],
      ingredients: [],
      dishes: [],
      shareCode: '',
      orderCount: 0,
      unseenCount: 0,
      saveState: 'idle',
      lastSavedAt: null,
      tab: U.store.get(KEY_TAB, 'ingredients') || 'ingredients',
      /* AI 结果区分两半：candidates＝正经推荐，explore＝换换口味。
         两半各自独立保存、各自独立清空，互不干扰。
         站里不再有内置模型，所以没有任何忙碌 / 进度 / 中止状态 ——
         菜是一次性粘回来的，粘完即出。 */
      candidates: [],
      explore: [],
      exploreAngle: '',
      exploreError: '',
      /* 「用你自己的 AI」粘贴式：面板开合 / 目标哪一半 / 用户粘回来的原文。
         ownText 一定要进 state，不能只留在 DOM 里 —— 切个 tab 再切回来
         就会整块重绘，textarea 被重建，用户辛苦复制粘贴的一大段直接没了。 */
      ownOpen: false,
      ownMode: 'stable',
      ownText: '',
      ownError: '',
      /* 复制提示词那一刻抽到的方向。粘回来时直接沿用这一个，
         不再重新抽 —— 否则界面显示的「这一轮走的是 X」和用户手上那段
         提示词里写的方向会对不上。 */
      ownAngleId: '',
      orders: [],
      ordersLoaded: false,
    };
  }

  function readDraft() {
    const d = U.store.get(KEY_DRAFT, null);
    return d && typeof d === 'object' ? d : null;
  }

  function asBool(v, def) {
    if (v === true || v === 'true' || v === 1 || v === '1') return true;
    if (v === false || v === 'false' || v === 0 || v === '0') return false;
    return def;
  }

  /* 条件值一律归一成布尔/数字。存过脏值（比如字符串 "false"）时，
     `x === true` 这类判断会静默失效，开关看起来就是「点了没反应」。 */
  function normSettings(src) {
    const o = (src && typeof src === 'object') ? src : {};
    const wasAll = asBool(o.matchesAll, true);
    /* matchesAll 现在不是独立开关，而是 allowMissing 的派生值：
       缺 0 样 = 必须全部食材都已经有。
       老数据里两个字段可能各说各话（默认值是 matchesAll=true、allowMissing=3），
       所以这里按老语义搬一次家：说是"必须全有"的就当缺 0 样，
       没说是的才读 allowMissing —— 不然老用户的条件会被悄悄放宽。 */
    let n = wasAll ? 0 : Math.round(Number(o.allowMissing));
    if (isNaN(n)) n = 0;
    n = Math.max(0, Math.min(10, n));
    return {
      matchesAll: n === 0,
      allowMissing: n,
      people: o.people == null ? '2' : String(o.people).slice(0, 12),
      avoid: o.avoid == null ? '' : String(o.avoid).slice(0, 60),
      useBasePantry: asBool(o.useBasePantry, true),
      meal: o.meal == null ? '' : String(o.meal).slice(0, 16),
      mealCustom: o.mealCustom == null ? '' : String(o.mealCustom).slice(0, 40),
    };
  }

  function writeDraft() {
    const s = cs();
    U.store.set(KEY_DRAFT, {
      cookName: s.cookName,
      title: s.title,
      note: s.note,
      settings: s.settings,
      takeouts: s.takeouts,
      ingredients: s.ingredients,
      dishes: s.dishes,
      shareCode: s.shareCode,
      dirtyAt: Date.now(),
    });
  }

  /* 外卖条目的归一化。这些字段会原样进云端、再显示给点菜的人，
     所以长度要卡住，缺的字段补空串，别让 undefined 落到界面上。 */
  function normTakeouts(src) {
    const arr = Array.isArray(src) ? src : [];
    return arr.slice(0, 30).map(function (t) {
      const o = (t && typeof t === 'object') ? t : {};
      return {
        id: o.id ? String(o.id).slice(0, 40) : U.uid(),
        shop: o.shop == null ? '' : String(o.shop).slice(0, 30),
        item: o.item == null ? '' : String(o.item).slice(0, 40),
        where: o.where == null ? '' : String(o.where).slice(0, 40),
        price: o.price == null ? '' : String(o.price).slice(0, 16),
        note: o.note == null ? '' : String(o.note).slice(0, 80),
        selected: o.selected !== false,
      };
    }).filter(function (t) { return t.shop || t.item; });
  }

  async function init() {
    window.KF.state.cook = emptyState();
    const s = cs();
    ensureToken();

    /* 1) 先用本机草稿把界面点亮 */
    const draft = readDraft();
    if (draft) {
      s.cookName = draft.cookName || '';
      s.title = draft.title || '今天的菜单';
      s.note = draft.note || '';
      if (draft.settings) s.settings = normSettings(Object.assign({}, s.settings, draft.settings));
      s.takeouts = normTakeouts(draft.takeouts);
      s.ingredients = Array.isArray(draft.ingredients) ? draft.ingredients : [];
      s.dishes = Array.isArray(draft.dishes) ? draft.dishes : [];
      s.shareCode = draft.shareCode || '';
    }

    /* 2) 再拉服务端。服务端更新更晚就以服务端为准，否则把本机草稿推上去 */
    try {
      const server = await API.getKitchen(s.cookToken);
      if (server) {
        const serverAt = new Date(server.updated_at).getTime();
        const localAt = draft && draft.dirtyAt ? draft.dirtyAt : 0;
        s.shareCode = server.share_code || s.shareCode;
        s.orderCount = Number(server.order_count) || 0;
        s.unseenCount = Number(server.unseen_count) || 0;
        /* 记下云端最后保存的时刻。以前这里没记，于是保存那行在刷新后是空白的 ——
           明明刚从云端把数据拉下来，却像什么都没存过一样。 */
        s.lastSavedAt = server.updated_at || null;
        if (serverAt > localAt) {
          s.cookName = server.cook_name || '';
          s.title = server.title || '今天的菜单';
          s.note = server.note || '';
          if (server.settings) s.settings = normSettings(Object.assign({}, s.settings, server.settings));
          s.takeouts = normTakeouts(server.takeouts);
          s.ingredients = Array.isArray(server.ingredients) ? server.ingredients : [];
          s.dishes = Array.isArray(server.dishes) ? server.dishes : [];
        } else {
          scheduleSave();
        }
      } else if (draft) {
        /* 服务端还没有这份厨房，把草稿推上去 */
        scheduleSave();
      }
    } catch (e) {
      U.toast('云端连接失败，已切到本机草稿模式：' + U.errText(e), 'err');
    }

    s.loaded = true;
    lastUnseen = s.unseenCount;

    /* 拉完云端就知道东西是在的，直接显示"已保存到云端 …"。
       以前这里留着空白：数据明明好好地在云端，页面却像什么都没存过。
       只有在确实没改动、也没在存/出错的时候才这么标。 */
    if (s.lastSavedAt && s.saveState !== 'dirty' && s.saveState !== 'saving' && s.saveState !== 'error') {
      s.saveState = 'saved';
    }
    startStateTicker();
  }

  function stopPolling() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  }

  function startPolling() {
    stopPolling();
    pollTimer = setInterval(function () {
      if (document.hidden) return;
      if (window.KF.state.route.name !== 'cook') { stopPolling(); return; }
      refreshOrders(true);
    }, 15000);
  }

  /* ---------- 保存 ---------- */

  const scheduleSave = U.debounce(doSave, 900);
  const scheduleDraft = U.debounce(writeDraft, 400);

  function markDirty() {
    const s = cs();
    s.saveState = 'dirty';
    scheduleDraft();
    scheduleSave();
    refreshSaveState();
  }

  async function doSave() {
    const s = cs();
    if (!s.cookToken) return;
    s.saveState = 'saving';
    refreshSaveState();
    try {
      const res = await API.upsertKitchen(s.cookToken, {
        cook_name: s.cookName || '下厨的人',
        title: s.title || '今天的菜单',
        note: s.note || '',
        settings: s.settings,
        takeouts: s.takeouts || [],
        ingredients: s.ingredients,
        dishes: s.dishes,
      });
      if (res && res.share_code) s.shareCode = res.share_code;
      if (res && res.updated_at) s.lastSavedAt = res.updated_at;
      s.saveState = 'saved';
      writeDraft();
      refreshSaveState();
      refreshShareBar();
    } catch (e) {
      s.saveState = 'error';
      refreshSaveState();
      U.toast('保存失败：' + U.errText(e), 'err');
    }
  }

  function saveNow() {
    /* 先把待写的本机草稿落盘，再取消待触发的定时保存，最后立刻存一次。
       少了 cancel，900ms 后还会再存一遍，白跑一趟网络。 */
    if (scheduleDraft.cancel) { scheduleDraft.cancel(); writeDraft(); }
    const s = cs();
    if (s.saveState === 'dirty') {
      if (scheduleSave.cancel) scheduleSave.cancel();
      doSave();
    }
  }

  /* 为什么"已保存到云端"那个时间要单独拎出来处理：
     它是用「当前时间」去比较的（当天＝今天 09:40，过了零点＝9月19日 09:40）。
     可页面只在保存完成的那一瞬间刷新一次，之后时间照样往前走 ——
     晚上存好、手机扣在桌上，第二天早上拿起来看，它还会一直写着「今天 09:40」，
     明明已经是昨天的事了。时间是最经不起放的东西，所以每过一分钟就重算一次。
     只刷新那行文字，不碰别的，免得把正在输入的东西弄乱。 */
  const REFRESH_STATE_MS = 60000;

  function startStateTicker() {
    if (stateTicker) return;
    stateTicker = setInterval(function () {
      /* 离开下厨端就别刷新了，省得白跑 */
      if (!window.KF.state.route || window.KF.state.route.name !== 'cook') return;
      const s = cs();
      /* 只有"已保存"那行才跟时间有关，别的时候不用刷 */
      if (!s || s.saveState !== 'saved') return;
      refreshSaveState();
    }, REFRESH_STATE_MS);
  }

  function saveStateText() {
    const s = cs();
    if (s.saveState === 'saving') return '<span class="spinner dark"></span>正在保存…';
    if (s.saveState === 'dirty') return '有改动待保存';
    if (s.saveState === 'saved') return '已保存到云端 ' + U.fmtTime(s.lastSavedAt);
    if (s.saveState === 'error') return '保存失败';
    return '';
  }

  function saveStateClass() {
    const st = cs().saveState;
    return st === 'dirty' ? 'dirty' : (st === 'saved' ? 'saved' : '');
  }

  function refreshSaveState() {
    const els = document.querySelectorAll('[data-save-state]');
    for (let i = 0; i < els.length; i++) {
      els[i].className = 'save-state ' + saveStateClass();
      els[i].innerHTML = saveStateText();
    }
  }

  function refreshShareBar() {
    const s = cs();
    const codeEl = document.getElementById('share-code');
    if (codeEl) codeEl.textContent = s.shareCode || '——';
    const cntEl = document.getElementById('share-count');
    if (cntEl) cntEl.textContent = String(pickedDishes().length);
  }

  /* 分享只走菜单码这一条路：6 位码好念、好抄、好发，对方在浏览器里输一次就进菜单。
     链接和微信文案都不再提供 —— 手输码是唯一入口，所以码本身要能点一下复制。 */

  /* ---------- 局部重绘（保住输入焦点与光标） ---------- */

  function rerender() {
    const ae = document.activeElement;
    const id = ae && ae.id ? ae.id : null;
    let sel = null;
    try { if (ae && typeof ae.selectionStart === 'number') sel = ae.selectionStart; } catch (e) { sel = null; }
    renderTab();
    if (id) {
      const el = document.getElementById(id);
      if (el) {
        try {
          el.focus();
          if (sel != null && typeof el.setSelectionRange === 'function') el.setSelectionRange(sel, sel);
        } catch (e) { /* 忽略 */ }
      }
    }
  }

  /* ---------- 渲染入口 ---------- */

  function render(host) {
    const s = cs();
    host.innerHTML =
      '<h1>下厨工作台</h1>' +
      '<p class="lede">把家里现有的东西填进去，让 AI 出几道菜，再把菜单分享出去。</p>' +
      shareBarHtml() +
      tabBarHtml() +
      '<div id="tab-body"></div>';

    renderTab();
    startPolling();
    if (!s.ordersLoaded) refreshOrders(false);
  }

  function shareBarHtml() {
    const s = cs();
    return '' +
      '<div class="share-bar">' +
        '<div>' +
          '<div class="lbl">菜单码</div>' +
          '<div class="share-code" id="share-code" title="点击复制菜单码">' + U.esc(s.shareCode || '——') + '</div>' +
        '</div>' +
        '<div>' +
          '<div class="lbl">当前菜单</div>' +
          '<div><b id="share-count">' + pickedDishes().length + '</b> 道菜</div>' +
        '</div>' +
        '<div class="spacer"></div>' +
        '<div class="btn-row">' +
          '<button class="btn" id="btn-copy-code">复制菜单码</button>' +
          '<button class="btn" id="btn-open-guest">预览点菜端</button>' +
        '</div>' +
      '</div>';
  }

  function tabBarHtml() {
    const s = cs();
    const tabs = [
      ['ingredients', '我的食材'],
      ['ai', 'AI 找菜'],
      ['menu', '我的菜单'],
      ['orders', '收到的点单'],
    ];
    let h = '<div class="tabs">';
    tabs.forEach(function (t) {
      const badge = (t[0] === 'orders' && s.unseenCount > 0)
        ? '<span class="dot">' + s.unseenCount + '</span>' : '';
      h += '<button class="tab' + (s.tab === t[0] ? ' active' : '') + '" data-tab="' + t[0] + '">' +
           t[1] + badge + '</button>';
    });
    h += '</div>';
    return h;
  }

  /* 只更新订单那个红点，不整个替换标签栏（替换会吞掉正落在上面的点击） */
  function refreshTabBadge() {
    const s = cs();
    const btn = document.querySelector('.tabs [data-tab="orders"]');
    if (!btn) return;
    let dot = btn.querySelector('.dot');
    if (s.unseenCount > 0) {
      if (!dot) {
        dot = document.createElement('span');
        dot.className = 'dot';
        btn.appendChild(dot);
      }
      if (dot.textContent !== String(s.unseenCount)) dot.textContent = s.unseenCount;
    } else if (dot) {
      dot.remove();
    }
  }

  /* tab 的高亮（那个黑底胶囊）必须自己更新。
     以前只有整页 render() 才会重画 tab 栏，所以点了别的 tab 之后：
     内容区换了、黑框却还留在原来那个上面；要等别的原因触发一次整页重绘，
     它才「延迟」跳过去 —— 看起来就是「点了没反应」。
     现在把它做成独立的、只改 class 的轻量更新，并且放在 renderTab 的第一步，
     点击后同步生效，不受下面内容区重绘快慢的影响。 */
  function paintTabBar() {
    const s = cs();
    const btns = document.querySelectorAll('.tabs [data-tab]');
    for (let i = 0; i < btns.length; i++) {
      const btn = btns[i];
      const on = btn.dataset.tab === s.tab;
      if (btn.classList.contains('active') !== on) btn.classList.toggle('active', on);
    }
  }

  function renderTab() {
    const s = cs();
    /* 先让高亮跟上手指，再去画内容 —— 内容重不重都不影响点击反馈 */
    paintTabBar();
    const body = document.getElementById('tab-body');
    if (!body) return;
    if (s.tab === 'ingredients') body.innerHTML = ingredientsHtml();
    else if (s.tab === 'ai') body.innerHTML = aiHtml();
    else if (s.tab === 'menu') body.innerHTML = menuHtml();
    else body.innerHTML = ordersHtml();
  }

  /* 监听器一律挂在 document 上，不挂在路由容器上。
     容器每次进路由都会被换成一个全新节点，挂在它上面的监听器会跟着节点一起被丢掉 ——
     表现就是「按钮明明在，点了完全没反应，而且不报任何错」。
     挂 document 只绑一次，永远跑不掉。 */
  let docBound = false;

  function bind() {
    if (docBound) return;
    docBound = true;
    document.addEventListener('click', onDocClick);
    document.addEventListener('input', onInput);
    document.addEventListener('change', onInput);
  }

  function onDocClick(e) {
    /* 只有下厨端才处理，别去接点菜端和首页的点击 */
    if (window.KF.state.route.name !== 'cook') return;
    if (!cs()) return;
    if (!e.target || !e.target.closest || !e.target.closest('#view')) return;

    const tabBtn = e.target.closest('.tabs [data-tab]');
    if (tabBtn) {
      cs().tab = tabBtn.dataset.tab;
      U.store.set(KEY_TAB, cs().tab);
      renderTab();
      if (cs().tab === 'orders') refreshOrders(false);
      return;
    }

    onClick(e);
  }

  /* ---------- 事件 ---------- */

  function onClick(e) {
    const s = cs();
    const t = e.target;

    /* 菜单码本身点一下也能复制。它不是 <button>，所以要赶在按钮判断之前接住 */
    if (t.closest && t.closest('#share-code')) { copyCode(); return; }

    const btn = t.closest('button');
    if (!btn) return;

    /* 选项按钮必须在这里处理：<button> 不触发 change，
       只有 input / select 才会，所以挂在 onInput 上的逻辑收不到。 */
    const field = btn.dataset.field;
    if (field === 'allowMissing') { setAllowMissing(btn.dataset.value); return; }
    if (field === 'meal') { setMeal(btn.dataset.value); return; }
    /* 「用你自己的 AI」面板里选目标。仍然走 onClick 这条 data-field 分支 ——
       <button> 不派发 change，挂在 onInput 上收不到。 */
    if (field === 'ownMode') { setOwnMode(btn.dataset.value); return; }

    const act = btn.dataset.act;

    if (btn.id === 'btn-copy-code') { copyCode(btn); return; }
    if (btn.id === 'btn-open-guest') { openGuestPreview(btn); return; }
    if (btn.id === 'ing-add') { addIngredientFromInput(); return; }
    if (btn.dataset.quick) { addIngredient(btn.dataset.quick, guessCategory(btn.dataset.quick)); return; }

    switch (act) {
      case 'del-ing': {
        const id = btn.dataset.id;
        s.ingredients = s.ingredients.filter(function (x) { return x.id !== id; });
        markDirty(); rerender();
        break;
      }
      /* 粘贴式那一步的动作。开合和清空只要重画这一张卡，
         不要整页 rerender —— 下面的菜卡没必要跟着重建。 */
      case 'own-open': {
        s.ownOpen = true; s.ownError = '';
        paintOwnCard();
        /* 重画之后是新节点，把 state 里的原文再按一次。
           HTML 里已经渲染了 value，这一步是防解析器的边界行为
           （紧跟 <textarea> 的那个换行会被浏览器吃掉）——
           用户粘的是一大段东西，少一个换行不值得让他重粘。 */
        const box = document.getElementById('ai-own-text');
        if (box && s.ownText) box.value = s.ownText;
        break;
      }
      case 'own-close': s.ownOpen = false; s.ownError = ''; paintOwnCard(); break;
      case 'own-clear': s.ownText = ''; s.ownError = ''; paintOwnCard(); break;
      case 'own-copy': copyOwnPrompt(); break;
      case 'own-ingest': ingestOwn(); break;
      case 'clear-cand': s.candidates = []; rerender(); break;
      case 'add-one': {
        const cand = s.candidates.filter(function (c) { return c.id === btn.dataset.id; })[0];
        if (!cand) return;
        if (s.dishes.some(function (d) { return d.name === cand.name; })) {
          U.toast('“' + cand.name + '”已经在菜单里了');
          return;
        }
        s.dishes.push(toMenuItem(cand));
        markDirty();
        /* 只把这一张卡的按钮改成「已在菜单中」，不去重建整页 */
        paintCandidate(cand.id);
        refreshShareBar();
        U.toast('已加入菜单：' + cand.name, 'ok');
        break;
      }
      case 'add-all': {
        const pool = s.candidates.filter(function (c) { return c.allowed; });
        let n = 0;
        pool.forEach(function (c) {
          if (s.dishes.some(function (d) { return d.name === c.name; })) return;
          s.dishes.push(toMenuItem(c));
          n++;
        });
        if (!n) { U.toast('没有新的可加入菜品'); return; }
        markDirty(); rerender();
        U.toast('已加入 ' + n + ' 道菜', 'ok');
        break;
      }
      case 'add-custom': openDishEditor(null); break;
      case 'edit-dish': openDishEditor(btn.dataset.id); break;
      /* 外卖 / 下馆子的选项 */
      case 'add-takeout': openTakeoutEditor(null); break;
      case 'edit-takeout': openTakeoutEditor(btn.dataset.id); break;
      case 'del-takeout': {
        s.takeouts = (s.takeouts || []).filter(function (t) { return t.id !== btn.dataset.id; });
        markDirty();
        refreshTakeoutCard();
        U.toast('删掉了');
        break;
      }
      case 'del-dish': {
        s.dishes = s.dishes.filter(function (d) { return d.id !== btn.dataset.id; });
        markDirty(); rerender();
        break;
      }
      case 'open-tutorial': {
        /* 教程链接是要在用户的浏览器里真正打开的 —— 这是整个应用唯一一个
           「把外部内容送到用户面前」的动作，所以必须在这里再过一道安检。
           云端存着的旧菜单可能还带着已经出事的站点（香哈、心食谱、美食杰
           都被赌博站沾过），AI.safeUrl 会把它们替换成一次安全搜索，
           绝不原样打开。用户自己指定的来源同样过这一道。 */
        const raw = btn.dataset.url;
        const id = btn.dataset.id;
        const site = btn.dataset.site;
        const own = btn.dataset.own === '1';

        /* 点教程＝"我就学这份"。记下来：等他自己没贴参考图时，
           参考图那块就标这一份教程。再点同一个可以取消。

           这里只改 class 和那一行小字，不重画整张卡片 —— 重画会把节点换掉，
           用户正在点的那排按钮会跟着消失，下一下就没得点了。 */
        if (id && site) {
          const d = findDish(id);
          if (d) {
            d.tutorialPick = (d.tutorialPick === site) ? '' : site;
            markDirty();
            paintTutorialPick(id);
          }
        }

        const safe = AI.safeUrl(btn.dataset.dish || '', raw);
        if (safe !== raw) {
          U.toast('这个来源已不可用，已换成安全搜索');
        } else if (own) {
          /* 我们自己没验过这个页面，别装作验过 */
          U.toast('这是你自己填的来源，我们没验证过内容');
        }
        /* 教程链接原来就在新标签页打开，所以"换口味"点它不会离开结果区。
           但用户可能只是想看看、结果被切走了 —— 提醒一句，别让他以为丢了。 */
        if (cs().tab === 'ai' && !findDish(id) && findExplore(id)) {
          U.toast('在新标签页打开了，这一轮换个花样的结果还在');
        }
        window.open(safe, '_blank', 'noopener,noreferrer');
        break;
      }
      case 'refresh-orders': refreshOrders(false); break;
      case 'mark-seen': markSeen(); break;
      case 'reset-all': confirmReset(); break;

      /* ---------- 换换口味那一半 ----------
         这一半现在没有运行按钮（站内没有模型可调），结果同样由
         「用你自己的 AI」粘回来，只是目标选成 explore。 */
      case 'clear-explore': {
        s.explore = []; s.exploreError = '';
        paintExplore();
        break;
      }
      case 'ex-add-one': {
        const c = findExplore(btn.dataset.id);
        if (!c) return;
        if (s.dishes.some(function (d) { return d.name === c.name; })) {
          U.toast('“' + c.name + '”已经在菜单里了');
          return;
        }
        s.dishes.push(toMenuItem(c));
        markDirty();
        paintCandidate(c.id);
        refreshShareBar();
        U.toast('已加入菜单：' + c.name, 'ok');
        break;
      }
    }
  }

  /* 换口味那一半里的候选。跟 s.candidates 分开存，所以要多一个查找口。 */
  function findExplore(id) {
    return (cs().explore || []).filter(function (c) { return c.id === id; })[0] || null;
  }

  /* 复制菜单码 —— 分享唯一剩下的那条路。6 位码好念、好抄、好发，
     对方在浏览器里打开本站输一次就进菜单，不用跟长网址较劲。
     两个坑要躲：
     1) 菜单码是等云端保存返回才生成的。以前先同步取、取不到就提示
        「先加几道菜」—— 可菜明明有，只是保存还没回来，看着就像按钮坏了。
        现在先等保存真的成功，再复制。
     2) 自动写剪贴板会被浏览器拒绝（内嵌预览窗口里很常见），
        这时候退回弹框让人手动复制，不能出现"点了没反应"。 */
  async function copyCode(btn) {
    const label = btn ? btn.textContent : '';
    if (btn) { btn.disabled = true; btn.textContent = '正在准备…'; }
    try {
      if (!cs().shareCode) await ensureSaved();
    } catch (e) {
      /* 保存失败也往下走，下面按实际拿到的码兜底提示 */
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = label || '复制菜单码'; }
    }

    const code = cs().shareCode;
    if (!code) { U.toast('菜单还没存到云端，检查一下网络再试', 'err'); return; }
    U.copyText(code).then(function () {
      U.toast('菜单码已复制：' + code + '，让对方打开本站输这 6 位', 'ok');
    }, function () {
      U.manualCopy(code, '复制菜单码');
    });
  }

  async function openGuestPreview(btn) {
    const label = btn ? btn.textContent : '';
    if (btn) { btn.disabled = true; btn.textContent = '正在准备…'; }
    try {
      await ensureSaved();
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = label || '预览点菜端'; }
    }
    const code = cs().shareCode;
    if (!code) { U.toast('菜单还没存到云端，检查一下网络再试', 'err'); return; }
    location.hash = '#/m/' + code;
  }

  /* 要菜单码之前，先把本地改动真正写进云端 */
  async function ensureSaved() {
    const s = cs();
    if (!s.cookToken) return;
    if (!s.shareCode || s.saveState === 'dirty') {
      if (scheduleSave.cancel) scheduleSave.cancel();
      await doSave();
    }
  }

  function onInput(e) {
    /* 监听器挂到了 document 上，所以要先确认这一下确实是下厨端里的输入 */
    if (window.KF.state.route.name !== 'cook') return;
    if (!cs()) return;
    const s = cs();
    const el = e.target;
    if (!el || !el.dataset) return;
    const f = el.dataset.field;
    if (!f) return;
    if (f === 'cookName') { s.cookName = el.value; markDirty(); return; }
    if (f === 'title') { s.title = el.value; markDirty(); return; }
    if (f === 'note') { s.note = el.value; markDirty(); return; }
    if (f === 'avoid') { s.settings.avoid = el.value; markDirty(); return; }
    if (f === 'people') { s.settings.people = el.value; markDirty(); return; }
    if (f === 'mealCustom') { s.settings.mealCustom = el.value; markDirty(); return; }
    /* 用户粘回来的那段结果。只存 state、**故意不重绘** ——
       重绘会把 textarea 整个换掉，光标位置和滚动全都丢，
       用户粘到一半想手动改两个字都改不了。 */
    if (f === 'ownText') { s.ownText = el.value; return; }

    if (f === 'allowMissing') { setAllowMissing(el.value); return; }
    if (f === 'useBasePantry') {
      s.settings.useBasePantry = !!el.checked;
      markDirty(); return;
    }
    if (f === 'dishNote') {
      const d = findDish(el.dataset.id);
      if (d) { d.note = el.value; markDirty(); }
      return;
    }
    /* 外卖选项的「给点菜的人看」开关。onInput 同时收 input 和 change，
       checkbox 走的是 change，所以这里能收到。 */
    if (f === 'takeoutOn') {
      const id = el.dataset.id;
      const on = !!el.checked;
      let hit = false;
      (s.takeouts || []).forEach(function (t) {
        if (t.id !== id) return;
        if (t.selected !== false === on) return;   /* 没变就不动 */
        t.selected = on;
        hit = true;
      });
      if (hit) { markDirty(); refreshTakeoutCard(); }
      return;
    }
    if (f === 'ing-input' && e.type === 'change') return;
  }

  function onKeydown(e) {
    if (e.target && e.target.id === 'ing-input' && e.key === 'Enter') {
      e.preventDefault();
      addIngredientFromInput();
    }
  }

  /* ---------- 选菜条件（按钮和输入框共用同一套写入口） ---------- */

  /* 改条件后两半都要跟着刷新。顺序上先刷条件卡（它自己会被替换掉），
     再刷结果区。下半整块重画即可。 */
  function refreshAfterCondChange() {
    paintConditions();
    syncResults({ rebuild: true });
    if (cs().explore.length || cs().exploreError) paintExplore();
  }

  function setAllowMissing(n) {
    const s = cs();
    n = Math.round(Number(n));
    if (isNaN(n)) n = 0;
    n = Math.max(0, Math.min(10, n));
    if (Number(s.settings.allowMissing) === n) return;
    s.settings.allowMissing = n;
    /* matchesAll 是这一排数字的派生值，一起写掉 ——
       否则 ai.js 会读到两个互相矛盾的条件。 */
    s.settings.matchesAll = (n === 0);
    recomputeAllowed();
    markDirty();
    refreshAfterCondChange();
  }

  /* 换这一顿。只改条件卡，不重跑 AI —— 已经想出来的菜留着，
     用户可能只是想让排序变一下，不想把结果清掉重来。 */
  function setMeal(id) {
    const s = cs();
    const next = String(id || '');
    if (s.settings.meal === next) return;
    s.settings.meal = next;
    if (next !== 'custom') s.settings.mealCustom = '';
    markDirty();
    paintConditions();
  }

  /* 档位相关的东西（KEY_MODEL、window.KF.modelChoice、setModelChoice、
     paintModelCard）全都没了 —— 站里没有模型档位可挑，也没人再去调云端模型。 */

  /* ---------- 食材 ---------- */

  function guessCategory(name) {
    const spicy = ['花椒', '八角', '干辣椒', '桂皮', '香叶', '孜然', '五香粉', '辣椒粉', '白胡椒粉', '黑胡椒'];
    const season = ['生抽', '老抽', '蚝油', '料酒', '醋', '香油', '豆瓣酱', '番茄酱', '盐', '糖', '淀粉', '鸡精', '味精', '食用油', '白糖'];
    if (spicy.indexOf(name) >= 0) return '香料';
    if (season.indexOf(name) >= 0) return '调味';
    if (/肉|牛|猪|羊|鸡|鸭|排骨|培根|香肠|火腿/.test(name)) return '肉禽';
    if (/鱼|虾|蟹|贝|蛤|鱿|海带|紫菜/.test(name)) return '水产';
    if (/蛋|奶|芝士|黄油|酸奶/.test(name)) return '蛋奶';
    if (/豆腐|豆干|腐竹|豆皮/.test(name)) return '豆制品';
    if (/菇|菌|木耳|香菇|口蘑|金针/.test(name)) return '菌菇';
    if (/米|面|粉|粉丝|馒头|饺子皮|年糕/.test(name)) return '主食';
    return '蔬菜';
  }

  function addIngredient(name, category) {
    const s = cs();
    name = String(name || '').trim();
    if (!name) return;
    if (name.length > 20) name = name.slice(0, 20);
    const exists = s.ingredients.some(function (x) {
      return x.name === name;
    });
    if (exists) { U.toast('“' + name + '”已经在列表里了'); return; }
    s.ingredients.push({ id: U.uid(), name: name, category: category || guessCategory(name) });
    markDirty(); rerender();
  }

  function addIngredientFromInput() {
    const input = document.getElementById('ing-input');
    const catEl = document.getElementById('ing-cat');
    if (!input) return;
    const raw = input.value || '';
    const cat = catEl ? catEl.value : '';
    const parts = raw.split(/[,,;;、\s]+/).map(function (x) { return x.trim(); }).filter(Boolean);
    if (!parts.length) return;
    const s = cs();
    let added = 0;
    parts.slice(0, 20).forEach(function (p) {
      const name = p.slice(0, 20);
      if (s.ingredients.some(function (x) { return x.name === name; })) return;
      s.ingredients.push({ id: U.uid(), name: name, category: cat || guessCategory(name) });
      added++;
    });
    if (!added) { U.toast('这些都已经在列表里了'); return; }
    input.value = '';
    markDirty(); rerender();
    U.toast('已加入 ' + added + ' 样食材', 'ok');
  }

  function ingredientsHtml() {
    const s = cs();
    let h = '';

    h += '<div class="card">';
    h += '<div class="card-head"><h2>家里有什么</h2><div class="spacer"></div>' +
         '<span class="save-state ' + saveStateClass() + '" data-save-state>' + saveStateText() + '</span></div>';

    h += '<div class="row">' +
           '<div class="grow"><input type="text" id="ing-input" placeholder="输入食材，逗号分隔可以一次加多个"></div>' +
           '<select id="ing-cat" class="fixed-140">' +
             '<option value="">自动归类</option>' +
             CATEGORIES.map(function (c) { return '<option value="' + c + '">' + c + '</option>'; }).join('') +
           '</select>' +
           '<button class="btn btn-primary" id="ing-add">添加</button>' +
         '</div>';

    h += '<div class="field" style="margin-top:14px"><label>常用食材，点一下就加</label>' +
         '<div class="pill-group">' +
         QUICK_ADD.map(function (n) {
           return '<button class="pill" data-quick="' + U.esc(n) + '">+ ' + U.esc(n) + '</button>';
         }).join('') +
         '</div></div>';

    h += '<hr class="sep">';

    if (!s.ingredients.length) {
      h += '<div class="empty"><div class="big">🧺</div><p>还没填食材。</p></div>';
    } else {
      const groups = {};
      s.ingredients.forEach(function (x) {
        const c = x.category || '其他';
        (groups[c] = groups[c] || []).push(x);
      });
      const order = CATEGORIES.filter(function (c) { return groups[c]; });
      Object.keys(groups).forEach(function (c) { if (order.indexOf(c) < 0) order.push(c); });

      order.forEach(function (c) {
        h += '<div class="ing-group"><div class="ing-group-title">' + U.esc(c) +
             ' · ' + groups[c].length + '</div><div class="ing-list">';
        groups[c].forEach(function (x) {
          h += '<span class="ing">' + U.esc(x.name) +
               '<button data-act="del-ing" data-id="' + x.id + '" title="移除">×</button></span>';
        });
        h += '</div></div>';
      });

      h += '<div class="btn-row" style="margin-top:6px">' +
           '<button class="btn btn-danger btn-sm" data-act="reset-all">清空全部食材和菜单</button>' +
           '</div>';
    }

    h += '</div>';
    return h;
  }

  /* ---------- AI ---------- */

  /* 选项按钮。注意：<button> 不会派发 change 事件，
     所以这类开关一律由 onClick 里的 data-field 分支处理，不要挂在 onInput 上。 */
  function pillBtn(field, value, label, on) {
    return '<button type="button" class="pill' + (on ? ' on' : '') + '" data-field="' + field + '"' +
           (value === null || value === undefined ? '' : ' data-value="' + value + '"') +
           (on ? ' aria-pressed="true"' : '') + '>' + U.esc(label) + '</button>';
  }

  /* 选菜条件整卡。给它一个 id：改条件时只换这一小块，
     不去重建下面十几张菜卡（那才是「点一下卡半拍」的原因）。 */
  /* 这一顿吃的是什么。默认让 AI 按当前时间判断 —— 大多数人不会想去设置它，
     而"现在 7 点"这个信息本身就是最有用的默认值。 */
  function mealCardHtml() {
    const s = cs();
    const chosen = s.settings.meal || '';

    let h = '<div class="field"><label>这一顿是</label>' +
      '<div class="pill-group">' +
        pillBtn('meal', '', '让 AI 看时间自己定', !chosen) +
        AI.meals.map(function (m) {
          return pillBtn('meal', m.id, m.label, chosen === m.id);
        }).join('') +
        pillBtn('meal', 'custom', '我自己说', chosen === 'custom') +
      '</div>';

    if (chosen === 'custom') {
      h += '<input type="text" id="ai-meal-custom" data-field="mealCustom" style="margin-top:10px" ' +
           'value="' + U.esc(s.settings.mealCustom || '') + '" placeholder="如 下午茶 / 加班餐 / 病号饭">';
    }

    h += '</div>';
    return h;
  }

  function condCardHtml() {
    const s = cs();
    let h = '<div class="card" id="ai-cond-card">';
    h += '<div class="card-head"><h2>这一顿怎么吃</h2></div>';

    h += mealCardHtml();

    /* 「最多允许缺几样」是**唯一**的条件入口：选 0 就等于"必须全部食材都已经有"。
       以前这里还压着一对总开关（必须全部已有 / 允许缺几样），跟下面这排数字
       说的是同一件事，撤掉了 —— settings.matchesAll 改成由这个数字反推。 */
    const cur = Number(s.settings.allowMissing) || 0;
    const opts = [0, 1, 2, 3, 4, 5, 6];
    if (opts.indexOf(cur) < 0) opts.push(cur);
    opts.sort(function (a, b) { return a - b; });
    h += '<div class="field" style="margin-top:14px"><label>一道菜最多允许缺几样</label>' +
         '<div class="pill-group">' +
         opts.map(function (n) {
           return pillBtn('allowMissing', n, n === 0 ? '一样都不能缺' : '缺 ' + n + ' 样', cur === n);
         }).join('') +
         '</div></div>';

    h += '<div class="row">' +
           '<div class="grow"><label style="font-size:13px;font-weight:600;display:block;margin-bottom:5px">几个人吃</label>' +
             '<input type="text" id="ai-people" data-field="people" value="' + U.esc(s.settings.people || '') + '" placeholder="2"></div>' +
           '<div class="grow"><label style="font-size:13px;font-weight:600;display:block;margin-bottom:5px">不吃 / 忌口</label>' +
             '<input type="text" id="ai-avoid" data-field="avoid" value="' + U.esc(s.settings.avoid || '') + '" placeholder="如 不吃香菜、不吃辣"></div>' +
         '</div>';

    h += '<label class="small" style="display:flex;gap:8px;align-items:flex-start;margin-top:14px;cursor:pointer">' +
           '<input type="checkbox" id="ai-pantry" data-field="useBasePantry" ' + (s.settings.useBasePantry ? 'checked' : '') +
           ' style="width:auto;margin-top:3px">' +
           '<span>把<span class="mono">盐、食用油、糖、生抽、老抽、料酒、淀粉、白胡椒粉、葱、姜、蒜、醋、香油、蚝油、鸡精</span>当成家里默认就有</span>' +
         '</label>';

    h += '</div>';
    return h;
  }

  /* AI 页分两半：
       上半「正经推荐」——同样的条件每次给的东西基本一致，用来稳定挑菜；
       下半「换换口味」——每次点都不一样，用来找想不起来的做法。
     两半各自有独立的运行按钮和忙碌状态，互不阻塞。 */
  /* ---------- AI 找菜这一页的构成 ----------

     站里**不再有任何内置模型**。整条链路只剩一种走法：
       填好条件和食材 → 复制提示词 → 去自己手机上的 AI 应用里跑 → 粘回来。

     所以这一页从上到下就是四块：条件卡、粘贴卡、正经推荐结果、换换口味结果。
     以前还压着一张「AI 分析」卡（一个按钮直接调站内的零额度模型），
     连同它的忙碌态、思考流进度、停止生成、档位回退提示一起撤掉了。 */
  function aiHtml() {
    return condCardHtml() +
      ownCardHtml() +
      resultsShellHtml() +
      exploreShellHtml();
  }

  /* ---------- 「用哪个 AI」这张卡已经整张撤掉 ----------

     它以前只回答一个问题：钱是谁出的。现在这个问题不用问了 —— 站里只走
     「用你自己的 AI」一条路（下面那张卡），算力在用户自己的手机上，
     谁都一分钱不花，也没有"快档 / 免费档"要挑。

     顺带撤掉的：只有一个档位的只读展示格（假控件）、以及那张
     「不会花你的钱」的长说明。留着它们，用户还得先读一段才明白
     "这里没得选"，不如让页面直接从"怎么办"开始。 */

  /* ---------- 用你自己的 AI（粘贴式） ----------

     **这是站里唯一的 AI 用法。** 站内那个零额度模型连同它的模型档位表、
     白名单、回退逻辑一起删掉了（见 ai.js），页面任何地方都不会再去调云端大模型。

     为什么只能人工中转：**网页拿不到手机上那些 App 的接口**
     （手机系统助手没有 Web API；Apple 的端侧模型只对原生 App 开放；
     浏览器端侧模型官方不支持手机版 Chrome）。所以走复制 / 粘贴两个动作。

     ---- 两个容易做错的地方 ----
     1) 文案里不能出现"连接""授权""读取你的应用"这类词。这里只有复制和粘贴
        两个动作，说成"接入"会让人以为站点要读他的 App —— 一听就像要偷数据。
     2) 粘回来的结果必须走**同一套解析**（AI.ingestExternal → normalizeDish）。
        不然会出现"缺材料不标黄"这种事，用户只会得出一个结论：我那个 AI 算错了。

     ---- 为什么粘回来的要放回"对应的那一半" ----
     两半的提示词不一样：换换口味会带一个方向、还会避开上一批给过的菜。
     所以面板上要选目标，粘回来的结果才能落进对的那一边。 */
  function ownCardHtml() {
    const s = cs();
    const open = !!s.ownOpen;

    let h = '<div class="card" id="ai-own-card">';
    h += '<div class="card-head"><h2>用你自己的 AI</h2></div>';

    if (!open) {
      h += '<div class="btn-row" style="margin-top:12px">' +
           '<button class="btn btn-primary" data-act="own-open">用手机上的 AI 出菜 →</button>' +
           '</div>';
      h += '</div>';
      return h;
    }

    /* 目标选哪一半。默认正经推荐；从下面那半过来的话用户自己点一下。 */
    h += '<div style="margin-top:14px"><label style="font-size:13px;font-weight:600;display:block;margin-bottom:5px">' +
         '这份结果放进哪一半</label>' +
         '<div class="pill-group">' +
         pillBtn('ownMode', 'stable', '正经推荐（稳定）', s.ownMode !== 'explore') +
         pillBtn('ownMode', 'explore', '换换口味（每次不同）', s.ownMode === 'explore') +
         '</div></div>';

    h += '<div class="field" style="margin-top:14px">' +
         '<label>第 1 步 · 复制提示词</label>' +
         '<div class="btn-row" style="margin-top:9px">' +
         '<button class="btn" data-act="own-copy">复制提示词</button>' +
         '</div></div>';

    h += '<div class="field">' +
         '<label>第 2 步 · 把结果粘回来</label>' +
         '<textarea id="ai-own-text" data-field="ownText" rows="6" style="margin-top:9px" ' +
         'placeholder="粘在这里：包含那段 JSON 的整段回复">' + U.esc(s.ownText || '') + '</textarea>' +
         '<div class="btn-row" style="margin-top:9px">' +
         '<button class="btn btn-primary" data-act="own-ingest">把这段变成菜</button>' +
         '<button class="btn btn-ghost" data-act="own-clear">清空</button>' +
         '<button class="btn btn-ghost" data-act="own-close">收起</button>' +
         '</div></div>';

    if (s.ownError) {
      h += '<div class="note-bar err" style="margin-top:14px">' + U.esc(s.ownError) + '</div>';
    }

    h += '</div>';
    return h;
  }

  /* 只重画这一张卡，不动别的。面板上的动作（开合 / 换目标 / 清空）都走它 ——
     整页 rerender 会把下面的菜卡全部重建，没必要。 */
  function paintOwnCard() {
    const card = document.getElementById('ai-own-card');
    if (!card) return;
    const tmp = document.createElement('div');
    tmp.innerHTML = ownCardHtml();
    if (tmp.firstChild) card.replaceWith(tmp.firstChild);
  }

  function setOwnMode(v) {
    const s = cs();
    const next = v === 'explore' ? 'explore' : 'stable';
    if (next === s.ownMode) return;
    s.ownMode = next;
    paintOwnCard();
  }

  /* 复制提示词。提示词是按**当前条件现算的**，不是一段固定文本 ——
     用户填的食材、忌口、人数、这一顿都得进去，否则他那个 AI 会推荐一些
     他冰箱里根本没有的菜，看着就像"你这个提示词没用"。
     复制失败退回"弹框手动复制"，跟复制菜单码那条路一致：
     内嵌预览窗口里自动写剪贴板经常被拒。 */
  function copyOwnPrompt() {
    const s = cs();
    if (s.ingredients.length < 3) {
      U.toast('至少填 3 样食材 —— 提示词里要带上你家里有什么', 'err');
      return;
    }
    const ctx = aiContext(s.ownMode);
    /* 把这一轮抽到的方向钉住。
       aiContext 每调一次都会**重新抽一个方向**（那是"每次结果不同"的关键），
       所以粘回来时若再调一次，抽到的就是另一个方向了 —— 提示词里写的和
       界面最后显示的「这一轮走的是 X」会对不上。这里存一份，粘的时候沿用。 */
    s.ownAngleId = ctx.angleId || '';
    const text = AI.ownPrompt(ctx);
    U.copyText(text).then(function () {
      U.toast('提示词已复制，去你那个 AI 应用里粘贴发送', 'ok');
    }, function () {
      U.manualCopy(text, '复制提示词');
    });
  }

  /* 第 2 步：把粘回来的那段解析成菜，塞进对应的那一半。
     解析走的是 AI.ingestExternal —— 跟提示词是配套的一对，所以"哪些材料算没有"
     "这道菜符不符合条件"的判定和提示词里的规则完全一致。 */
  function ingestOwn() {
    const s = cs();
    if (s.ingredients.length < 3) {
      U.toast('至少填 3 样食材，才好在里面搭出菜来', 'err');
      return;
    }
    let res;
    try {
      /* 用复制提示词时钉住的那个方向，不用新抽的 —— 见 aiContext 的 pinnedAngle。
         没钉住（用户没复制过提示词）就传 null：宁可不显示方向，也不编一个。 */
      res = AI.ingestExternal(s.ownText,
        aiContext(s.ownMode, s.ownMode === 'explore' ? (s.ownAngleId || null) : undefined));
    } catch (err) {
      s.ownError = U.errText(err);
      paintOwnCard();
      return;
    }

    const ok = res.dishes.filter(function (c) { return c.allowed; }).length;
    if (res.mode === 'explore') {
      s.explore = res.dishes;
      recomputeAllowed();
      /* 只在"确实是照着我们给的方向出的菜"时才写上方向。
         用户没走复制那一步的话 res.angleId 是空的，界面就退回
         「这一轮的花样」—— 不替他编一个没收到过的方向。
         不做 `|| s.exploreAngle` 的兜底：那会把**上一轮**的方向留在
         界面上，看着像是这一轮走的方向。 */
      s.exploreAngle = res.angleId || '';
      s.exploreError = '';
      U.toast('换出 ' + res.dishes.length + ' 道「' + (res.angleLabel || '新花样') + '」，其中 ' +
              ok + ' 道符合条件', 'ok');
    } else {
      s.candidates = res.dishes;
      recomputeAllowed();
      U.toast('认出 ' + res.dishes.length + ' 道菜，其中 ' + ok + ' 道符合条件', 'ok');
    }

    /* 做完就收起面板、清空输入框：结果已经在下面了。
       留着那一大段文本只会让人以为还得再点一次。 */
    s.ownOpen = false;
    s.ownText = '';
    s.ownError = '';
    rerender();
  }

  /* 现在能缺几样。matchesAll 已经是 allowMissing 的派生值，
     所以这里直接读数字就够，不用再判那个布尔。 */
  function allowNow() {
    return Math.max(0, Number(cs().settings.allowMissing) || 0);
  }

  /* 条件一改，已经想出来的菜立刻按新条件重新分组 —— 不用重跑 AI。
     两半都要重算，否则改完条件只有上半跟着变、下半还挂着旧分组。 */
  function recomputeAllowed() {
    const s = cs();
    const allow = allowNow();
    s.candidates.forEach(function (c) {
      c.allowed = Math.max(0, Number(c.missingCount) || 0) <= allow;
    });
    (s.explore || []).forEach(function (c) {
      c.allowed = Math.max(0, Number(c.missingCount) || 0) <= allow;
    });
  }

  function setText(id, v) {
    const el = document.getElementById(id);
    if (el && el.textContent !== String(v)) el.textContent = String(v);
  }

  /* 正经推荐那一半的卡头。
     以前「清空结果」挂在「AI 分析」那张卡上 —— 那张卡没了，这个按钮得跟着搬家，
     否则用户粘错一段就再也清不掉。换换口味那边本来就有自己的「清空」。 */
  function resultHeadHtml(okLen) {
    const s = cs();
    return '<div class="card-head" id="ai-result-head"><h2>' +
      '认出来 <span id="ai-total-count">' + s.candidates.length + '</span> 道菜' +
      '</h2><div class="spacer"></div>' +
      (okLen
        ? '<button class="btn btn-herb btn-sm" data-act="add-all">把符合条件的 ' + okLen + ' 道全加进菜单</button>'
        : '') +
      '<button class="btn btn-ghost btn-sm" data-act="clear-cand">清空</button>' +
      '</div>';
  }

  function okEmptyText() {
    const s = cs();
    const n = Math.max(0, Number(s.settings.allowMissing) || 0);
    return '按现在的要求（' + (n === 0 ? '必须全部已有' : '最多允许缺 ' + n + ' 样') +
      '），没有完全符合条件的菜。可以放宽条件，或看下面的分组。';
  }

  function okEmptyHtml() {
    return '<div class="note-bar warn" id="ai-ok-empty">' + U.esc(okEmptyText()) + '</div>';
  }

  /* 结果区外壳。菜卡放进带 id 的容器里，粘完一次性铺开。
     这里不再有"流式上屏"，所以也不需要处理忙碌态。 */
  function resultsShellHtml() {
    const s = cs();

    if (!s.candidates.length) {
      return '<div class="card" id="ai-empty-card"><div class="empty"><div class="big">🍳</div>' +
             '<p>还没有结果。</p></div></div>';
    }

    const ok = s.candidates.filter(function (c) { return c.allowed; });
    const near = s.candidates.filter(function (c) { return !c.allowed; });
    const allow = allowNow();

    let h = '<div class="card" id="ai-result-card">';
    h += resultHeadHtml(ok.length);

    h += '<h3>符合条件 · <span id="ai-ok-count">' + ok.length + '</span> 道</h3>';
    h += '<div id="ai-ok-list">' + ok.map(function (c) { return candidateCard(c, allow); }).join('') + '</div>';
    h += okEmptyHtml();
    h += '<details class="steps" id="ai-near-wrap"' + (near.length ? '' : ' style="display:none"') + '>' +
         '<summary>再多买几样就能做 · <span id="ai-near-count">' + near.length + '</span> 道</summary>' +
         '<div id="ai-near-list" style="margin-top:12px">' +
         near.map(function (c) { return candidateCard(c, allow); }).join('') +
         '</div></details>';
    h += '</div>';
    return h;
  }

  /* ---------- 下半：换换口味 ----------

     跟上半是**两块独立的卡**，不共用列表容器：清掉这一半的时候，
     上面那半已经挑好的东西不会被冲掉。

     这一半的规矩跟上面正好相反：同一个冰箱、同一个时段，每次都要不一样的菜。
     做法在 ai.js 里 —— 每一轮抽一个方向（蒸炖 / 凉拌 / 一锅出 …），
     并把上一轮给过的菜名写进提示词让模型避开。

     **它自己不再有运行按钮**：站内没有模型可调了，这一半的花样同样由
     「用你自己的 AI」出，粘回来时把目标选成「换换口味」即可。 */
  function exploreShellHtml() {
    const s = cs();

    let h = '<div class="card" id="ai-explore-card">';

    h += '<div class="card-head"><h2>换换口味</h2><div class="spacer"></div>' +
         (s.explore.length ? '<button class="btn btn-ghost btn-sm" data-act="clear-explore">清空</button>' : '') +
         '</div>';

    if (s.exploreError) {
      h += '<div class="note-bar err" style="margin-top:14px">' + U.esc(s.exploreError) + '</div>';
    }

    if (s.explore.length) {
      const allow = allowNow();
      const ok = s.explore.filter(function (c) { return c.allowed; });
      h += '<div class="ex-head">' +
           (s.exploreAngle
             ? '这一轮走的是 <b>' + U.esc(AI.angleLabel(s.exploreAngle)) + '</b>'
             : '这一轮的花样') +
           ' · 共 <b id="ai-ex-total">' + s.explore.length + '</b> 道，' +
           '<b id="ai-ex-oknum">' + ok.length + '</b> 道现在就能做</div>';

      /* 每次换的一批整体放在同一个容器里：换批时整块换掉是对的，
         因为旧的那批就是要被替换的东西（跟上半不同，上半是要保留的）。 */
      h += '<div id="ai-ex-list">' +
           s.explore.map(function (c) { return exploreCard(c, allow); }).join('') +
           '</div>';
    } else {
      h += '<div class="empty" style="padding:18px 0"><div class="big">🎲</div>' +
           '<p>还没有花样。用上面那张卡，目标选「换换口味」。</p></div>';
    }

    h += '</div>';
    return h;
  }

  /* 换口味那一半的卡片。比上面的候选卡少一层分组（不分"符合条件/待补齐"），
     每张卡上直接标出缺什么 —— 这一半本来就图个"随便看看"。 */
  function exploreCard(c, allow) {
    const s = cs();
    const already = s.dishes.some(function (d) { return d.name === c.name; });
    let h = '<div class="dish-card ex-card" data-exid="' + U.esc(c.id) + '">';

    h += '<div class="dish-top"><h3 class="dish-name">' + U.esc(c.name) + '</h3><div class="dish-meta">';
    if (c.cuisine) h += '<span class="chip">' + U.esc(c.cuisine) + '</span>';
    if (c.timeMinutes) h += '<span class="chip">约 ' + c.timeMinutes + ' 分钟</span>';
    if (c.missingCount === 0) h += '<span class="chip chip-ok">材料齐全</span>';
    else h += '<span class="chip chip-miss">缺 ' + c.missingCount + ' 样</span>';
    h += '</div></div>';

    if (c.reason) h += '<p class="dish-reason">' + U.esc(c.reason) + '</p>';

    h += '<div class="mat-list">';
    c.materials.forEach(function (m) {
      h += '<span class="mat ' + (m.have ? 'have' : 'miss') + '">' +
           (m.have ? '✓' : '＋') + ' ' + U.esc(m.name) +
           '<span class="mat-type">' + U.esc(m.type) + '</span>' +
           (m.amount ? '<span class="mat-amount">' + U.esc(m.amount) + '</span>' : '') +
           '</span>';
    });
    h += '</div>';

    h += U.factsHtml(c);

    h += '<div class="dish-actions">';
    h += '<button class="btn btn-primary btn-sm" data-act="ex-add-one" data-id="' + c.id + '"' +
         (already ? ' disabled' : '') + '>' + (already ? '已在菜单中' : '加入菜单') + '</button>';
    h += '</div>';

    h += U.tutorialHtml(c);

    h += '</div>';
    return h;
  }

  /* 换口味那一半的重绘。整块换掉是合理的 —— 换批＝整批替换。 */
  function paintExplore() {
    if (cs().tab !== 'ai') return;
    if (window.KF.state.route.name !== 'cook') return;
    const card = document.getElementById('ai-explore-card');
    if (!card) { rerender(); return; }
    const tmp = document.createElement('div');
    tmp.innerHTML = exploreShellHtml();
    if (tmp.firstChild) card.replaceWith(tmp.firstChild);
  }

  function fillList(listId, arr, allow) {
    const box = document.getElementById(listId);
    if (!box) return;
    const want = {};
    arr.forEach(function (c) { want[c.id] = 1; });

    const kids = box.querySelectorAll('.dish-card[data-cid]');
    for (let i = 0; i < kids.length; i++) {
      if (!want[kids[i].dataset.cid]) kids[i].remove();
    }

    arr.forEach(function (c) {
      if (box.querySelector('.dish-card[data-cid="' + c.id + '"]')) return;
      const tmp = document.createElement('div');
      tmp.innerHTML = candidateCard(c, allow);
      if (tmp.firstChild) box.appendChild(tmp.firstChild);
    });
  }

  let _headKey = '';

  /* 结果区唯一更新入口。opts.rebuild = 整块重建（改了条件要重排时用）。
     粘回来的结果是一次性铺开的，所以这里没有"边算边补"的分支。 */
  function syncResults(opts) {
    opts = opts || {};
    if (cs().tab !== 'ai') return;
    if (window.KF.state.route.name !== 'cook') return;

    const s = cs();
    if (!s.candidates.length) { if (opts.rebuild) rerender(); return; }

    const allow = allowNow();
    const ok = s.candidates.filter(function (c) { return c.allowed; });
    const near = s.candidates.filter(function (c) { return !c.allowed; });

    const card = document.getElementById('ai-result-card');
    if (!card || opts.rebuild) {
      const html = resultsShellHtml();
      if (!html) return;
      const tmp = document.createElement('div');
      tmp.innerHTML = html;
      const fresh = tmp.firstChild;
      if (!fresh) return;

      if (card) { _headKey = ''; card.replaceWith(fresh); return; }

      /* 空态卡：第一次粘回结果时，它就在原位换成真结果卡 */
      const empty = document.getElementById('ai-empty-card');
      if (empty) { _headKey = ''; empty.replaceWith(fresh); return; }

      /* 连空态卡都不在（换了 tab 又回来）：落在粘贴卡的后面 */
      const own = document.getElementById('ai-own-card');
      if (own) { _headKey = ''; own.insertAdjacentElement('afterend', fresh); return; }

      rerender();
      return;
    }

    fillList('ai-ok-list', ok, allow);
    fillList('ai-near-list', near, allow);

    const key = ok.length + '/' + s.candidates.length;
    if (key !== _headKey) {
      _headKey = key;
      const old = document.getElementById('ai-result-head');
      if (old) {
        const tmp = document.createElement('div');
        tmp.innerHTML = resultHeadHtml(ok.length);
        if (tmp.firstChild) old.replaceWith(tmp.firstChild);
      }
    }

    setText('ai-ok-count', ok.length);
    setText('ai-near-count', near.length);

    const nearWrap = document.getElementById('ai-near-wrap');
    if (nearWrap) nearWrap.style.display = near.length ? '' : 'none';

    const okEmpty = document.getElementById('ai-ok-empty');
    if (okEmpty) {
      const show = !ok.length;
      okEmpty.style.display = show ? '' : 'none';
      if (show && okEmpty.textContent !== okEmptyText()) okEmpty.textContent = okEmptyText();
    }
  }

  /* 只重画一张候选卡（写完做法、刚加入菜单之后），其余卡片一律不动 */
  function paintCandidate(id) {
    const s = cs();
    const c = s.candidates.filter(function (x) { return x.id === id; })[0];
    if (!c) {
      /* 不在上半就是在下半。两半的容器和卡名都不一样，分开找。 */
      const ex = s.explore.filter(function (x) { return x.id === id; })[0];
      if (!ex) return;
      const exNode = document.querySelector('#ai-ex-list .dish-card[data-exid="' + id + '"]');
      if (!exNode) { paintExplore(); return; }
      const etmp = document.createElement('div');
      etmp.innerHTML = exploreCard(ex, allowNow());
      if (etmp.firstChild) exNode.replaceWith(etmp.firstChild);
      return;
    }
    const node = document.querySelector('#ai-result-card .dish-card[data-cid="' + id + '"]');
    if (!node) { rerender(); return; }
    const tmp = document.createElement('div');
    tmp.innerHTML = candidateCard(c, allowNow());
    if (tmp.firstChild) node.replaceWith(tmp.firstChild);
  }

  function paintMenuDish(id) {
    const d = findDish(id);
    if (!d) return;
    const node = document.querySelector('#tab-body .dish-card[data-did="' + id + '"]');
    if (!node) { renderTab(); return; }
    const tmp = document.createElement('div');
    tmp.innerHTML = menuDishHtml(d);
    if (tmp.firstChild) node.replaceWith(tmp.firstChild);
  }

  function paintConditions() {
    const card = document.getElementById('ai-cond-card');
    if (!card) { rerender(); return; }
    const tmp = document.createElement('div');
    tmp.innerHTML = condCardHtml();
    if (tmp.firstChild) card.replaceWith(tmp.firstChild);
  }

  function candidateCard(c, allow) {
    const s = cs();
    const already = s.dishes.some(function (d) { return d.name === c.name; });
    let h = '<div class="dish-card" data-cid="' + U.esc(c.id) + '">';

    h += '<div class="dish-top"><h3 class="dish-name">' + U.esc(c.name) + '</h3><div class="dish-meta">';
    if (c.cuisine) h += '<span class="chip">' + U.esc(c.cuisine) + '</span>';
    if (c.difficulty) h += '<span class="chip">' + U.esc(c.difficulty) + '</span>';
    if (c.timeMinutes) h += '<span class="chip">约 ' + c.timeMinutes + ' 分钟</span>';
    if (c.missingCount === 0) h += '<span class="chip chip-ok">材料齐全</span>';
    else h += '<span class="chip chip-miss">缺 ' + c.missingCount + ' 样</span>';
    h += '</div></div>';

    if (c.reason) h += '<p class="dish-reason">' + U.esc(c.reason) + '</p>';

    h += '<div class="mat-list">';
    c.materials.forEach(function (m) {
      h += '<span class="mat ' + (m.have ? 'have' : 'miss') + '">' +
           (m.have ? '✓' : '＋') + ' ' + U.esc(m.name) +
           '<span class="mat-type">' + U.esc(m.type) + '</span>' +
           (m.amount ? '<span class="mat-amount">' + U.esc(m.amount) + '</span>' : '') +
           '</span>';
    });
    h += '</div>';

    if (c.missingCount > 0) {
      h += '<div class="note-bar warn" style="margin:11px 0 0">需要补买：' +
           c.missing.map(U.esc).join('、') + '</div>';
    }

    /* 做法是后补的：这样首屏只要等菜名和材料，快很多 */
    if (c.steps && c.steps.length) {
      h += '<details class="steps" open><summary>做法 ' + c.steps.length + ' 步</summary><ol>' +
           c.steps.map(function (x) { return '<li>' + U.esc(x) + '</li>'; }).join('') +
           '</ol></details>';
    }
    if (c.tips) h += '<div class="tips">小技巧：' + U.esc(c.tips) + '</div>';

    /* 热量 / 营养 / 注意事项。AI 第一轮就把这三项写好了，
       这里必须显示出来 —— 否则用户拿到的推荐里只有菜名和材料，
       最该看的那几行反而藏着。 */
    h += U.factsHtml(c);

    h += '<div class="dish-actions">';
    h += '<button class="btn btn-primary btn-sm" data-act="add-one" data-id="' + c.id + '"' +
         (already ? ' disabled' : '') + '>' + (already ? '已在菜单中' : '加入菜单') + '</button>';
    h += '</div>';

    h += U.tutorialHtml(c);

    h += '</div>';
    return h;
  }

  function toMenuItem(c) {
    return {
      id: U.uid(),
      name: c.name,
      source: c.source || 'ai',
      cuisine: c.cuisine || '',
      difficulty: c.difficulty || '',
      timeMinutes: c.timeMinutes || null,
      materials: (c.materials || []).map(function (m) {
        return { name: m.name, type: m.type, amount: m.amount || '', have: !!m.have };
      }),
      steps: c.steps || [],
      tips: c.tips || '',
      calories: c.calories || '',
      nutrition: c.nutrition || '',
      cautions: c.cautions || '',
      tutorialQuery: c.tutorialQuery || c.name,
      tutorials: c.tutorials || AI.tutorials(c.name, c.tutorialQuery),
      customSource: '',
      image: U.safeImage(c.image || c.imageUrl),
      tutorialPick: c.tutorialPick || '',
      note: '',
      selected: true,
    };
  }

  /* 当前选菜条件 → 给 AI 的上下文。
     mode 不传＝第一部分（正经推荐）；mode==='explore'＝第二部分（换换口味）。
     两部分共用同一份"我有什么、这一顿吃什么"，只有方向那几行不同。

     pinnedAngle：把"换换口味"的方向钉死在指定 id 上，不再抽新的。
       传 undefined ＝ 照旧随机抽一个（复制提示词时用）。
       传 null / '' ＝ **这一轮没有方向可言**（用户没走复制那一步，
         直接把别处的回复粘了进来）。这时候宁可不显示方向，也不能
         新抽一个 —— 抽了就是替他从没收到过的一句提示词背书名。
       传有效 id ＝ 用这一个。 */
  function aiContext(mode, pinnedAngle) {
    const s = cs();
    const explore = mode === 'explore';
    const foods = [];
    const spices = [];
    s.ingredients.forEach(function (x) {
      if (SPICE_CATS.indexOf(x.category) >= 0) spices.push(x.name);
      else foods.push(x.name);
    });

    /* 时段：用户点了就听他的；没点就让 AI 按当前钟点自己判断。
       年月日时刻一并带上 —— 模型不知道今天几号，时令菜得靠这个。 */
    const tc = AI.timeContext();
    const chosen = s.settings.meal || '';
    const isCustom = chosen === 'custom';
    const mealId = (!chosen || isCustom) ? AI.guessMeal() : chosen;
    const label = isCustom
      ? (s.settings.mealCustom || '自己定的这一顿')
      : AI.mealLabel(mealId);

    const ctx = {
      ingredients: foods,
      spices: spices,
      matchesAll: !!s.settings.matchesAll,
      allowMissing: Number(s.settings.allowMissing) || 0,
      people: s.settings.people || '',
      avoid: s.settings.avoid || '',
      useBasePantry: !!s.settings.useBasePantry,
      count: explore ? 6 : 12,
      /* 年月日 + 时刻 + 季节。模型不知道今天几号，时令菜全靠这一行。 */
      timeText: tc.text,
      /* 用户自己点了哪个时段就以他为准（包括"自己说"）；
         他什么都没点（meal === ''）才让 AI 按当前钟点自己判断。 */
      mealId: mealId,
      mealLabel: label,
      mealHint: isCustom ? '' : (AI.mealHint[mealId] || ''),
      mealCustom: isCustom ? (s.settings.mealCustom || '') : '',
      mealAuto: !chosen,
      mode: explore ? 'explore' : '',
    };

    if (explore) {
      /* 抽一个跟上一轮不一样的方向。这一行是"每次结果不同"的关键 —— 
         光靠温度，同一个 prompt 出来的前几道菜几乎不变。

         已经钉住方向时就不再抽：pickAngle 天生避开"上一轮"那个 id，
         再抽一次抽到的必然是**另一个**方向，界面最后写着「这一轮走的是 A」
         而用户手上那段提示词里写的是 B。 */
      let angle = null;
      if (pinnedAngle === undefined) {
        angle = AI.pickAngle(s.exploreAngle || '');
      } else if (pinnedAngle) {
        const lab = AI.angleLabel(pinnedAngle);
        if (lab) angle = { id: pinnedAngle, label: lab, hint: AI.angleHint(pinnedAngle) };
      }
      if (angle) {
        ctx.angleId = angle.id;
        ctx.angleLabel = angle.label;
        ctx.angleHint = angle.hint;
      }
      ctx.twist = AI.pickTwist();
      /* 已经给过的菜不要再给一遍，否则"换一批"看着没换 */
      ctx.avoidNames = s.explore.map(function (c) { return c.name; });
    }

    return ctx;
  }

  /* ---------- 站内生成（runPart / renderResultsSoon）已整块删除 ----------

     以前这里跑的是「调站内零额度模型 → 流式上屏」，所以有一整套配套：
     忙碌标记、思考流进度、停止生成（abort）、档位回退提示、
     每 300ms 合并一次的重绘节流。

     现在两端不再直接调模型：菜是用户自己手机上的 AI 出的，一次性粘回来，
     所以没有"边算边补"，也不需要那些进度与中断机制。
     菜进来的唯一入口是 ingestOwn()（粘贴），它复用同一套 normalizeDish 解析。 */

  /* 只把"挑了哪份教程"这件事画出来，不动卡片里别的节点。
     换掉整张卡片会让正在被点的那排按钮消失 —— 用户点第一个教程、
     回来想点第二个，发现按钮全没了。这里就地改 class 和小字。 */
  function paintTutorialPick(id) {
    const d = findDish(id);
    if (!d) return;
    const card = document.querySelector('.dish-card[data-did="' + id + '"]');
    if (!card) return;

    const pick = d.tutorialPick || '';
    const btns = card.querySelectorAll('.btn-tut');
    for (let i = 0; i < btns.length; i++) {
      btns[i].classList.toggle('is-picked', !!pick && btns[i].dataset.site === pick);
    }

    const block = card.querySelector('.tut-block');
    if (!block) return;
    let line = block.querySelector('.tut-picked');
    if (!pick) {
      if (line) line.remove();
      return;
    }
    const text = '✓ 参考图用「' + pick + '」这份教程';
    if (!line) {
      line = document.createElement('div');
      line.className = 'tut-picked';
      block.appendChild(line);
    }
    line.textContent = text;

    /* 参考图那块也可能是靠这次挑选才出现的，一起换掉（它自己是个独立节点，
       换它不会牵连旁边正在点的按钮）。 */
    const photo = card.querySelector('.dish-photo');
    const fresh = U.imageHtml(d);
    if (photo && !fresh) {
      photo.remove();
    } else if (photo) {
      const box = document.createElement('div');
      box.innerHTML = fresh;
      photo.parentNode.replaceChild(box.firstChild, photo);
    }
  }

  /* ---------- 自定义 / 编辑料理 ---------- */

  function findDish(id) {
    return cs().dishes.filter(function (d) { return d.id === id; })[0] || null;
  }

  function openDishEditor(dishId) {
    const existing = dishId ? findDish(dishId) : null;
    const draft = existing
      ? JSON.parse(JSON.stringify(existing))
      : {
          id: U.uid(), name: '', source: 'custom', cuisine: '', difficulty: '',
          timeMinutes: null, materials: [{ name: '', type: '食材', amount: '' }],
          steps: [], tips: '', tutorialQuery: '', tutorials: [], note: '', selected: true,
          image: '', tutorialPick: '',
        };

    const typesOpts = AI.materialTypes;

    function matRow(m) {
      return '<div class="mat-row">' +
        '<input type="text" class="m-name" placeholder="材料名" value="' + U.esc(m.name) + '">' +
        '<select class="m-type">' + typesOpts.map(function (t) {
          return '<option value="' + t + '"' + (m.type === t ? ' selected' : '') + '>' + t + '</option>';
        }).join('') + '</select>' +
        '<input type="text" class="m-amount qty" placeholder="用量" value="' + U.esc(m.amount) + '">' +
        '<button type="button" data-drop>×</button>' +
        '</div>';
    }

    const html =
      '<h3>' + (existing ? '编辑料理' : '添加一道自己的料理') + '</h3>' +
      '<div class="field"><label>菜名</label>' +
        '<input type="text" id="ed-name" value="' + U.esc(draft.name) + '" placeholder="如 妈妈做的红烧肉">' +
      '</div>' +

      /* 照片以前排在"小技巧"后面、八个字段的最底下，用户翻不到，
         连着两轮反馈"找不到添加照片的地方"。现在提到菜名紧跟着的
         第二个字段：打开编辑器第一眼就看见，不用往下滚。
         字段本身、id、保存逻辑都没动，只是换了位置。 */
      '<div class="field" style="margin-top:14px"><label>这道菜的照片（可以之后补）</label>' +
        '<div class="photo-picker" id="ed-photo">' +
          '<div class="photo-preview" id="ed-photo-prev"></div>' +
          '<div class="photo-acts">' +
            '<button type="button" class="btn btn-sm" id="ed-photo-pick">选一张照片</button>' +
            '<button type="button" class="btn btn-sm" id="ed-photo-clear">去掉</button>' +
            '<label class="photo-or">或者粘贴图片网址' +
              '<input type="text" id="ed-image" value="' + U.esc(draft.image || '') + '" ' +
                'placeholder="https://... 开头">' +
            '</label>' +
          '</div>' +
        '</div>' +
      '</div>' +
      '<div class="field"><label>需要哪些材料</label>' +
        '<div id="ed-mats">' + draft.materials.map(matRow).join('') + '</div>' +
        '<div class="btn-row" style="margin-top:6px"><button type="button" class="btn btn-sm" id="ed-add-mat">+ 加一行材料</button></div>' +
      '</div>' +
      '<div class="field"><label>做法（一行一步）</label>' +
        '<textarea id="ed-steps" rows="4" placeholder="五花肉切麻将块，冷水下锅焯去血水\n热锅放糖炒出糖色…">' + U.esc((draft.steps || []).join('\n')) + '</textarea>' +
      '</div>' +
      '<div class="row">' +
        '<div class="grow"><label style="font-size:13px;font-weight:600;display:block;margin-bottom:5px">风味</label>' +
          '<input type="text" id="ed-cuisine" value="' + U.esc(draft.cuisine || '') + '" placeholder="家常"></div>' +
        '<div class="fixed-100"><label style="font-size:13px;font-weight:600;display:block;margin-bottom:5px">难度</label>' +
          '<input type="text" id="ed-diff" value="' + U.esc(draft.difficulty || '') + '" placeholder="简单"></div>' +
        '<div class="fixed-100"><label style="font-size:13px;font-weight:600;display:block;margin-bottom:5px">分钟</label>' +
          '<input type="text" id="ed-time" value="' + U.esc(draft.timeMinutes || '') + '" placeholder="30"></div>' +
      '</div>' +
      '<div class="field" style="margin-top:14px"><label>小技巧（可不填）</label>' +
        '<input type="text" id="ed-tips" value="' + U.esc(draft.tips || '') + '" placeholder="一句话诀窍">' +
      '</div>' +
      '<div class="field"><label>教程搜索关键词</label>' +
        '<input type="text" id="ed-query" value="' + U.esc(draft.tutorialQuery || '') + '" placeholder="留空就用菜名">' +
      '</div>' +
      '<div class="field"><label>还想去哪找（可不填）</label>' +
        '<input type="text" id="ed-custom" value="' + U.esc(draft.customSource || '') +
          '" placeholder="如 下厨房 / 小红书 / 某个网页地址">' +
      '</div>' +
      '<div class="modal-foot">' +
        '<button type="button" class="btn" id="ed-cancel">取消</button>' +
        '<button type="button" class="btn btn-primary" id="ed-save">' + (existing ? '保存修改' : '加到菜单') + '</button>' +
      '</div>';

    const root = U.openModal(html);
    const matsBox = root.querySelector('#ed-mats');

    /* ---------- 照片 ----------
       本地选的照片要变成能存进云端、能在别人手机上也看到的字符串。
       直接读原图会有好几 MB，而云端字段存不下、手机流量也扛不住，
       所以先缩到最长边 1200px、压成 JPEG 再存。
       原图只在浏览器里处理，一个字节都不外传。 */
    let photo = draft.image || '';

    function paintPhoto() {
      const box = root.querySelector('#ed-photo-prev');
      if (!box) return;
      if (!photo) { box.innerHTML = '<span class="photo-empty">还没有照片</span>'; return; }
      box.innerHTML = '<img src="' + U.esc(photo) + '" alt="预览">';
    }

    /* 图片压缩。用 canvas 缩放 + toDataURL，不需要任何外部库。 */
    function shrinkImage(file, cb) {
      const MAX = 1200;
      const reader = new FileReader();
      reader.onload = function () {
        const img = new Image();
        img.onload = function () {
          let w = img.naturalWidth || img.width;
          let h = img.naturalHeight || img.height;
          if (!w || !h) { cb(''); return; }
          if (w > MAX || h > MAX) {
            if (w >= h) { h = Math.round(h * MAX / w); w = MAX; }
            else { w = Math.round(w * MAX / h); h = MAX; }
          }
          try {
            const cv = document.createElement('canvas');
            cv.width = w; cv.height = h;
            cv.getContext('2d').drawImage(img, 0, 0, w, h);
            cb(cv.toDataURL('image/jpeg', 0.82));
          } catch (e) {
            cb('');   /* 画布被污染 / 不支持，走降级提示 */
          }
        };
        img.onerror = function () { cb(''); };
        img.src = reader.result;
      };
      reader.onerror = function () { cb(''); };
      reader.readAsDataURL(file);
    }

    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = 'image/*';
    fileInput.style.display = 'none';
    root.appendChild(fileInput);

    fileInput.addEventListener('change', function () {
      const f = fileInput.files && fileInput.files[0];
      if (!f) return;
      if (!/^image\//.test(f.type || '')) { U.toast('请选一张图片', 'err'); return; }
      U.toast('正在处理照片…');
      shrinkImage(f, function (dataUrl) {
        if (!dataUrl) {
          U.toast('这张照片处理不了（可能格式特殊），换成粘贴图片网址试试', 'err');
          return;
        }
        /* 压缩后还是特别大的话就别存了 —— 云端字段和别人的流量都要顾 */
        if (dataUrl.length > 900000) {
          U.toast('照片太大了，换一张小一点的', 'err');
          return;
        }
        photo = dataUrl;
        paintPhoto();
        U.toast('照片已加好', 'ok');
      });
      fileInput.value = '';
    });

    root.querySelector('#ed-photo-pick').addEventListener('click', function () { fileInput.click(); });
    root.querySelector('#ed-photo-clear').addEventListener('click', function () {
      photo = '';
      root.querySelector('#ed-image').value = '';
      paintPhoto();
    });
    /* 粘贴网址也要能立刻看到效果。
       注意这里是"跟着输入框走"，不是"只在合法时更新" ——
       否则把一个合法的网址改成 javascript: 之后，预览里还挂着上一张图，
       看上去像是允许了，保存时却会被拦掉，前后不一致。 */
    root.querySelector('#ed-image').addEventListener('input', function () {
      const raw = String(this.value || '').trim();
      if (!raw) { photo = ''; paintPhoto(); return; }
      photo = U.safeImage(raw);      /* 不合法就是空串，预览会显示"还没有照片" */
      paintPhoto();
    });

    paintPhoto();

    root.querySelector('#ed-add-mat').addEventListener('click', function () {
      const wrap = document.createElement('div');
      wrap.innerHTML = matRow({ name: '', type: '食材', amount: '' });
      matsBox.appendChild(wrap.firstChild);
    });

    matsBox.addEventListener('click', function (e) {
      const btn = e.target.closest('[data-drop]');
      if (!btn) return;
      if (matsBox.querySelectorAll('.mat-row').length <= 1) {
        U.toast('至少留一行材料');
        return;
      }
      btn.closest('.mat-row').remove();
    });

    root.querySelector('#ed-cancel').addEventListener('click', U.closeModal);

    root.querySelector('#ed-save').addEventListener('click', function () {
      const name = root.querySelector('#ed-name').value.trim();
      if (!name) { U.toast('请填菜名', 'err'); return; }

      const materials = [];
      const rows = matsBox.querySelectorAll('.mat-row');
      for (let i = 0; i < rows.length; i++) {
        const n = rows[i].querySelector('.m-name').value.trim();
        if (!n) continue;
        materials.push({
          name: n.slice(0, 40),
          type: rows[i].querySelector('.m-type').value,
          amount: rows[i].querySelector('.m-amount').value.trim().slice(0, 24),
          have: false,
        });
      }
      if (!materials.length) { U.toast('至少填一样材料', 'err'); return; }

      const query = root.querySelector('#ed-query').value.trim() || name;
      const steps = root.querySelector('#ed-steps').value
        .split('\n').map(function (x) { return x.trim(); }).filter(Boolean);

      /* 用户自己指定的来源。这里必须挡一道，否则等于把一个
         "往别人浏览器里塞任意地址"的入口开放出去。
         填了但用不了的话，明确告诉他，不要默默丢掉 —— 默默丢掉的后果是
         他以为存上了，点菜的人却看不到那个入口。 */
      const customRaw = root.querySelector('#ed-custom').value.trim();
      const custom = customRaw ? AI.customTutorial(customRaw, query) : null;
      if (customRaw && !custom) {
        U.toast('这个来源用不了（只支持正常的 http/https 网址），先没加进去', 'err');
      }

      const list = AI.tutorials(name, query);
      if (custom) list.unshift(custom);

      const s = cs();
      const dish = {
        id: draft.id,
        name: name.slice(0, 40),
        source: existing ? (existing.source || 'custom') : 'custom',
        cuisine: root.querySelector('#ed-cuisine').value.trim().slice(0, 16),
        difficulty: root.querySelector('#ed-diff').value.trim().slice(0, 8),
        timeMinutes: parseInt(root.querySelector('#ed-time').value, 10) || null,
        materials: materials,
        steps: steps,
        tips: root.querySelector('#ed-tips').value.trim().slice(0, 160),
        tutorialQuery: query,
        tutorials: list,
        customSource: custom ? customRaw : '',
        /* 参考图：本地选的已经压成 dataURL，粘贴的过 safeImage。
           两条路都走 safeImage —— 它会放行 data:image/（我们自己压的），
           同时挡掉 javascript: 之类。 */
        image: '',
        tutorialPick: existing ? (existing.tutorialPick || '') : '',
        note: existing ? (existing.note || '') : '',
        selected: true,
      };

      /* 自建菜的材料按现有食材清单重算一次"有没有" */
      const pantry = [];
      s.ingredients.forEach(function (x) {
        const nn = AI.normName(x.name);
        if (nn) pantry.push(nn);
      });
      if (s.settings.useBasePantry) {
        AI.basePantry.forEach(function (x) {
          const nn = AI.normName(x);
          if (nn && pantry.indexOf(nn) < 0) pantry.push(nn);
        });
      }
      dish.materials.forEach(function (m) { m.have = AI.hasMaterial(pantry, m.name); });
      dish.image = U.safeImage(photo);

      if (existing) {
        const idx = s.dishes.findIndex(function (d) { return d.id === dish.id; });
        if (idx >= 0) s.dishes[idx] = dish; else s.dishes.push(dish);
      } else {
        s.dishes.push(dish);
      }

      U.closeModal();
      markDirty();
      if (s.tab !== 'menu') { s.tab = 'menu'; U.store.set(KEY_TAB, 'menu'); }
      renderTab();
      refreshShareBar();
      U.toast(existing ? '已更新：' + dish.name : '已加入菜单：' + dish.name, 'ok');
    });
  }

  /* ---------- 我的菜单 ---------- */

  function pickedDishes() {
    return cs().dishes.filter(function (d) { return d.selected !== false; });
  }

  function menuHtml() {
    const s = cs();
    const picked = pickedDishes();
    let h = '';

    h += '<div class="card">';
    h += '<div class="card-head"><h2>菜单信息</h2><div class="spacer"></div>' +
         '<span class="save-state ' + saveStateClass() + '" data-save-state>' + saveStateText() + '</span></div>';

    h += '<div class="row">' +
           '<div class="grow"><label style="font-size:13px;font-weight:600;display:block;margin-bottom:5px">你的称呼</label>' +
             '<input type="text" data-field="cookName" value="' + U.esc(s.cookName) + '" placeholder="如 阿舟"></div>' +
           '<div class="grow"><label style="font-size:13px;font-weight:600;display:block;margin-bottom:5px">菜单标题</label>' +
             '<input type="text" data-field="title" value="' + U.esc(s.title) + '" placeholder="今天的菜单"></div>' +
         '</div>';

    h += '<div class="field" style="margin-top:14px"><label>给点菜的人一句话</label>' +
         '<input type="text" data-field="note" value="' + U.esc(s.note) + '" placeholder="如 冰箱里有什么就做什么，随便点"></div>';

    h += '</div>';

    h += '<div class="card">';
    h += '<div class="card-head"><h2>已选 ' + picked.length + ' 道菜</h2><div class="spacer"></div>' +
         '<button class="btn btn-sm" data-act="add-custom">+ 添加自己的料理</button>' +
         '</div>';

    if (!picked.length) {
      h += '<div class="empty"><div class="big">📋</div><p>菜单还是空的。去「AI 找菜」挑几道，或者自己加一道。</p></div>';
    } else {
      picked.forEach(function (d) { h += menuDishHtml(d); });
    }

    h += '</div>';

    h += takeoutCardHtml();

    h += '<div class="card">';
    h += '<div class="card-head"><h2>分享给要点菜的人</h2></div>';
    if (!s.shareCode) {
      h += '<div class="note-bar warn">菜单保存后会自动生成菜单码，稍等一下。</div>';
    } else {
      h += '<div class="btn-row">' +
           '<button class="btn btn-primary" id="btn-copy-code">复制菜单码</button>' +
           '<button class="btn" id="btn-open-guest">预览点菜端</button>' +
           '</div>' +
           '<div class="note-bar" style="margin-top:12px">把菜单码发给对方，' +
           '让 TA 在自己的浏览器里打开本站、输这 6 位，就能点菜。</div>';
    }
    h += '</div>';

    return h;
  }

  function menuDishHtml(d) {
    const s = cs();
    let h = '<div class="dish-card is-picked" data-did="' + U.esc(d.id) + '">';
    h += '<div class="dish-top"><h3 class="dish-name">' + U.esc(d.name) + '</h3><div class="dish-meta">';
    if (d.cuisine) h += '<span class="chip">' + U.esc(d.cuisine) + '</span>';
    if (d.timeMinutes) h += '<span class="chip">约 ' + d.timeMinutes + ' 分钟</span>';
    h += '<span class="chip ' + (d.source === 'custom' ? 'chip-primary' : '') + '">' +
         (d.source === 'custom' ? '自己的料理' : 'AI 推荐') + '</span>';
    h += '</div></div>';

    h += U.imageHtml(d);

    if (d.materials && d.materials.length) {
      h += '<div class="mat-list">';
      d.materials.forEach(function (m) {
        h += '<span class="mat' + (m.have ? ' have' : '') + '">' +
             U.esc(m.name) +
             '<span class="mat-type">' + U.esc(m.type || '') + '</span>' +
             (m.amount ? '<span class="mat-amount">' + U.esc(m.amount) + '</span>' : '') +
             '</span>';
      });
      h += '</div>';
    }

    if (d.steps && d.steps.length) {
      h += '<details class="steps" open><summary>做法 ' + d.steps.length + ' 步</summary><ol>' +
           d.steps.map(function (x) { return '<li>' + U.esc(x) + '</li>'; }).join('') +
           '</ol></details>';
    }
    if (d.tips) h += '<div class="tips">小技巧：' + U.esc(d.tips) + '</div>';

    h += U.factsHtml(d);

    h += '<div class="field" style="margin-top:11px"><input type="text" data-field="dishNote" data-id="' + d.id +
         '" value="' + U.esc(d.note || '') + '" placeholder="给这道菜加个备注，如 少放辣"></div>';

    h += '<div class="dish-actions">';
    h += '<button class="btn btn-sm" data-act="edit-dish" data-id="' + d.id + '">编辑</button>';
    h += '<div style="margin-left:auto"><button class="btn btn-danger btn-sm" data-act="del-dish" data-id="' + d.id + '">从菜单移除</button></div>';
    h += '</div>';

    h += U.tutorialHtml(d);

    h += '</div>';
    return h;
  }

  /* ---------- 下厨的人也能提供外卖 / 下馆子 ----------

     有些晚上就是不想开火。与其让点菜的人在"菜单外"里自己写一条
     「想吃楼下的酸菜鱼」，不如下厨的人直接把几个选项摆出来：
     他清楚附近有什么、哪家能送、大概多少钱。

     这块内容跟着 settings 一起进云端，点菜端会看到并列出来，
     可以直接勾选。勾中之后提交上来的条目 kind='takeout'，
     在「收到的点单」里会单独标出来。 */
  function takeoutCardHtml() {
    const s = cs();
    const list = s.takeouts || [];
    const picked = list.filter(function (t) { return t.selected !== false; });

    let h = '<div class="card" id="takeout-card">';
    h += '<div class="card-head"><h2>不想开火的话</h2><div class="spacer"></div>' +
         '<button class="btn btn-sm" data-act="add-takeout">+ 加一个外卖 / 店里的选项</button></div>';
    if (!list.length) {
      h += '<div class="empty" style="padding:18px 0"><div class="big">🥡</div>' +
           '<p>还没有加任何外卖或店里的选项。</p></div>';
    } else {
      h += '<div class="takeout-list">';
      list.forEach(function (t) {
        h += '<div class="takeout-item' + (t.selected === false ? ' is-off' : '') + '">';
        h += '<label class="takeout-pick"><input type="checkbox" data-field="takeoutOn" data-id="' + U.esc(t.id) + '"' +
             (t.selected !== false ? ' checked' : '') + '><span>给点菜的人看</span></label>';
        h += '<div class="takeout-main">';
        h += '<span class="takeout-name">' + U.esc(t.item || t.shop || '（没写名字）') + '</span>';
        if (t.shop) h += '<span class="takeout-from">' + U.esc(t.shop) + '</span>';
        if (t.price) h += '<span class="takeout-price">' + U.esc(t.price) + '</span>';
        if (t.where) h += '<span class="takeout-where">' + U.esc(t.where) + '</span>';
        if (t.note) h += '<span class="takeout-note">' + U.esc(t.note) + '</span>';
        h += '</div>';
        h += '<div class="takeout-acts">' +
             '<button class="btn btn-sm" data-act="edit-takeout" data-id="' + U.esc(t.id) + '">编辑</button>' +
             '<button class="btn btn-sm btn-danger" data-act="del-takeout" data-id="' + U.esc(t.id) + '">删掉</button>' +
             '</div>';
        h += '</div>';
      });
      h += '</div>';
    }

    if (picked.length) {
      h += U.takeoutHtml(list, {
        head: (s.cookName || '下厨的人') + ' 说这顿也可以点这些',
        sub: '想吃哪个就直接勾，提交的时候会一起发过来。',
      });
    }

    h += '</div>';
    return h;
  }

  function findTakeout(id) {
    return (cs().takeouts || []).filter(function (t) { return t.id === id; })[0] || null;
  }

  /* 加 / 改一个外卖选项。跟料理编辑器一样做成弹窗，
     字段少、一屏看完，不占菜单页的地方。 */
  function openTakeoutEditor(id) {
    const existing = id ? findTakeout(id) : null;
    const d = existing || { id: '', shop: '', item: '', where: '', price: '', note: '' };

    const html =
      '<h3>' + (existing ? '改这个选项' : '加一个外卖 / 店里的选项') + '</h3>' +
      '<div class="field"><label>店名 / 平台</label>' +
        '<input type="text" id="tk-shop" maxlength="30" value="' + U.esc(d.shop) + '" ' +
        'placeholder="如 楼下的川菜馆、美团上那家"></div>' +
      '<div class="field"><label>想吃的商品（可不填）</label>' +
        '<input type="text" id="tk-item" maxlength="40" value="' + U.esc(d.item) + '" ' +
        'placeholder="如 香辣鸡腿堡套餐、酸菜鱼"></div></div>' +
      '<div class="row">' +
        '<div class="grow"><label style="font-size:13px;font-weight:600;display:block;margin-bottom:5px">怎么吃</label>' +
          '<input type="text" id="tk-where" maxlength="40" value="' + U.esc(d.where) + '" ' +
          'placeholder="点外卖送到家 / 一起去店里吃"></div>' +
        '<div class="fixed-100"><label style="font-size:13px;font-weight:600;display:block;margin-bottom:5px">大概多少钱</label>' +
          '<input type="text" id="tk-price" maxlength="16" value="' + U.esc(d.price) + '" placeholder="如 35 元"></div>' +
      '</div>' +
      '<div class="field" style="margin-top:14px"><label>想说明的话（可不填）</label>' +
        '<input type="text" id="tk-note" maxlength="80" value="' + U.esc(d.note) + '" ' +
        'placeholder="如 八点前能送到、要微辣"></div>' +
      '<div class="modal-foot">' +
        '<button type="button" class="btn" id="tk-cancel">取消</button>' +
        '<button type="button" class="btn btn-primary" id="tk-save">' + (existing ? '保存修改' : '加进去') + '</button>' +
      '</div>';

    const root = U.openModal(html);
    root.querySelector('#tk-cancel').addEventListener('click', U.closeModal);

    root.querySelector('#tk-save').addEventListener('click', function () {
      const g = function (sel) { return root.querySelector(sel).value.trim(); };
      const shop = g('#tk-shop');
      const item = g('#tk-item');
      if (!shop && !item) { U.toast('至少写个店名或者商品名', 'err'); return; }

      const s = cs();
      const row = {
        id: existing ? existing.id : U.uid(),
        shop: shop.slice(0, 30),
        item: item.slice(0, 40),
        where: g('#tk-where').slice(0, 40),
        price: g('#tk-price').slice(0, 16),
        note: g('#tk-note').slice(0, 80),
        selected: existing ? existing.selected !== false : true,
      };

      if (existing) {
        s.takeouts = (s.takeouts || []).map(function (t) { return t.id === existing.id ? row : t; });
      } else {
        if ((s.takeouts || []).length >= 30) { U.toast('最多加 30 个选项', 'err'); return; }
        s.takeouts = (s.takeouts || []).concat([row]);
      }

      U.closeModal();
      markDirty();
      refreshTakeoutCard();
      U.toast(existing ? '已更新' : '加好了，点菜的人会看到', 'ok');
    });
  }

  /* 外卖卡片的原地重绘。跟条件卡同样的做法：只换这一块，
     不去重建整个菜单页（重建会把下面所有菜卡的展开状态弄丢）。 */
  function refreshTakeoutCard() {
    const card = document.getElementById('takeout-card');
    if (!card) { rerender(); return; }
    const tmp = document.createElement('div');
    tmp.innerHTML = takeoutCardHtml();
    if (tmp.firstChild) card.replaceWith(tmp.firstChild);
  }

  function confirmReset() {
    const s = cs();
    const html =
      '<h3>清空全部内容？</h3>' +
      '<div class="note-bar warn">会把这份菜单里的 <b>' + s.ingredients.length + '</b> 样食材和 <b>' +
      s.dishes.length + '</b> 道菜全部删掉，已经发出去的菜单码会变成空菜单。这一步不能撤销。</div>' +
      '<div class="modal-foot">' +
        '<button type="button" class="btn" id="rs-cancel">算了</button>' +
        '<button type="button" class="btn btn-primary" id="rs-ok">确认清空</button>' +
      '</div>';
    const root = U.openModal(html);
    root.querySelector('#rs-cancel').addEventListener('click', U.closeModal);
    root.querySelector('#rs-ok').addEventListener('click', function () {
      s.ingredients = [];
      s.dishes = [];
      s.candidates = [];
      s.explore = [];
      s.takeouts = [];
      U.closeModal();
      markDirty();
      saveNow();
      rerender();
      U.toast('已清空', 'ok');
    });
  }

  /* ---------- 订单 ---------- */

  async function refreshOrders(silent) {
    const s = cs();
    const myToken = s.cookToken;
    if (!myToken) return;
    try {
      const list = await API.listOrders(myToken);
      if (cs().cookToken !== myToken) return;
      let arr = Array.isArray(list) ? list : [];
      /* 兜底：万一返回被多包了一层数组 */
      if (arr.length === 1 && Array.isArray(arr[0])) arr = arr[0];
      const unseen = arr.filter(function (o) { return !o.seen; }).length;

      if (silent && unseen > lastUnseen) {
        U.toast('有新的点单来了 🍽', 'ok');
      }
      s.orders = arr;
      s.ordersLoaded = true;
      s.unseenCount = unseen;
      s.orderCount = arr.length;
      lastUnseen = unseen;

      if (window.KF.state.route.name === 'cook') {
        refreshTabBadge();
        /* 只有内容真的变了才重画订单列表。原来每 15 秒无条件重建一次，
           刚好压在一次点击上时，那一下点击就白点了。 */
        const sig = arr.length + '|' + unseen + '|' +
          arr.reduce(function (a, o) { return a + (o.seen ? 1 : 0); }, 0) + '|' + (arr[0] ? arr[0].id : '');
        if (cs().tab === 'orders' && (sig !== lastOrdersSig || !silent)) {
          const body = document.getElementById('tab-body');
          if (body) body.innerHTML = ordersHtml();
        }
        lastOrdersSig = sig;
      }
    } catch (e) {
      if (!silent) U.toast('读取点单失败：' + U.errText(e), 'err');
    }
  }

  async function markSeen() {
    const s = cs();
    if (!s.unseenCount) { U.toast('没有未读的点单'); return; }
    try {
      await API.markOrdersSeen(s.cookToken);
      s.orders.forEach(function (o) { o.seen = true; });
      s.unseenCount = 0;
      lastUnseen = 0;
      refreshTabBadge();
      renderTab();
      U.toast('已全部标为已读', 'ok');
    } catch (e) {
      U.toast('操作失败：' + U.errText(e), 'err');
    }
  }

  function ordersHtml() {
    const s = cs();
    let h = '';

    h += '<div class="card">';
    h += '<div class="card-head"><h2>谁点了什么</h2><div class="spacer"></div>' +
         '<div class="btn-row">' +
           '<button class="btn btn-sm" data-act="refresh-orders">刷新</button>' +
           (s.unseenCount ? '<button class="btn btn-sm btn-herb" data-act="mark-seen">' + s.unseenCount + ' 条未读 · 全部标为已读</button>' : '') +
         '</div></div>';

    /* 把"菜单上没有、他们自己加的"单独点出来：这类条目最需要你回应，
       混在菜名里容易划过去。 */
    if (s.ordersLoaded && s.orders.length) {
      let wants = 0, takeout = 0;
      s.orders.forEach(function (o) {
        (o.items || []).forEach(function (it) {
          if (it.kind === 'takeout') takeout++;
          else if (it.kind === 'wish') wants++;
        });
      });
      if (wants || takeout) {
        h += '<div class="note-bar">' +
             '有 <b>' + (wants + takeout) + '</b> 条是菜单上没有的：' +
             (wants ? '<span class="own-tag">菜单外</span>' + wants + ' 道自己想吃的' : '') +
             (wants && takeout ? '，' : '') +
             (takeout ? '<span class="takeout-tag">外卖 / 店里</span>' + takeout + ' 条想吃外卖或去店里' : '') +
             '。</div>';
      }
    }

    if (!s.ordersLoaded) {
      h += '<div class="skeleton" style="width:60%"></div><div class="skeleton" style="width:40%"></div>';
    } else if (!s.orders.length) {
      h += '<div class="empty"><div class="big">🕊</div><p>还没有人点单。把菜单码发出去，等他们提交。</p></div>';
    } else {
      s.orders.forEach(function (o) {
        h += '<div class="order' + (o.seen ? '' : ' unseen') + '">';
        h += '<div class="order-head">' +
             '<span class="who">' + U.esc(o.guest_name || '匿名') + '</span>' +
             '<span class="when">' + U.esc(U.fmtTime(o.created_at)) + '</span>' +
             (!o.seen ? '<span class="badge">新</span>' : '') +
             '</div>';

        const items = Array.isArray(o.items) ? o.items : [];
        items.forEach(function (it) {
          const isTakeout = it.kind === 'takeout';
          const isWish = it.kind === 'wish';
          h += '<div class="pick-line' + (isTakeout || isWish ? ' no-star' : '') + '">';
          h += '<span>' +
               (isTakeout ? '<span class="takeout-tag">外卖 / 店里</span>'
                : isWish ? '<span class="own-tag">菜单外</span>' : '') +
               U.esc(it.name || '（已下架）') +
               (it.from ? '<span class="pick-from">' + U.esc(it.from) + '</span>' : '') +
               (it.price ? '<span class="pick-from">' + U.esc(it.price) + '</span>' : '') +
               (it.where ? '<span class="pick-note">' + U.esc(it.where) + '</span>' : '') +
               (it.note ? '<span class="pick-note">' + U.esc(it.note) + '</span>' : '') +
               '</span>';
          h += '<span class="st">' + (Number(it.stars) > 0
                 ? U.starsHtml(Number(it.stars), { readonly: true })
                 : (isTakeout || isWish ? '' : '<span class="muted small">未评分</span>')) + '</span>';
          h += '</div>';
        });

        if (o.message) h += '<div class="order-msg">留言：' + U.esc(o.message) + '</div>';
        h += '</div>';
      });
    }

    h += '</div>';
    return h;
  }

  window.KF.cook = {
    init: init,
    render: render,
    bind: bind,
    onKeydown: onKeydown,
    saveNow: saveNow,
    stopPolling: stopPolling,
    refreshShareBar: refreshShareBar,
  };
})();
