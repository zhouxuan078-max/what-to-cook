/* ==========================================================================
   点菜端：打开家人发来的菜单、打星、生成点单
   ========================================================================== */
window.KF = window.KF || {};

(function () {
  'use strict';

  const U = window.KF.util;
  /* 离线通道：菜单是从网址里本地解出来的，点单也是本地打包成链接的 */
  const SH = window.KF.share;
  /* 在线通道（可选）。下厨的人那边配了收单服务的话，这里提交完就直接送到他手上，
     不用再复制一条链接发过去。没配的时候这里所有调用都安静返回失败。 */
  const NET = window.KF.net;
  /* 必须取别名再调用。脚本顺序是 ai.js → cook.js → guest.js，所以这时已经就绪；
     但直接用裸的 AI.xxx 会在打包顺序变化或压缩后变成未定义引用，
     而且这里少写一行，下面的教程按钮点击就会整个抛错、点不动。 */
  const AI = window.KF.ai;

  const KEY_NAME = 'kf_guest_name_v1';

  function gs() { return window.KF.state.guest; }
  /* 键用载荷的短指纹，不用载荷本身 —— 一份菜单的载荷有一千多字符，
     拿来当键既难看、也会把 localStorage 的键撑得离谱。
     前缀带 v2：旧版是按 6 位菜单码存的，别把两种数据混在一起。 */
  function draftKey(id) { return 'kf_guest_draft_v2_' + id; }
  function sentKey(id) { return 'kf_guest_sent_v2_' + id; }

  function reset(code) {
    window.KF.state.guest = {
      code: code || '',
      /* 载荷的短指纹，用来当本机草稿和"已经生成过"的键 */
      codeKey: '',
      menu: null,
      /* 下厨的人的厨房编号，跟着菜单一起过来。没有它就只能走链接那条路
         （旧链接、或者下厨的人那个站没配收单服务，都是这种情况）。 */
      kid: '',
      loading: false,
      error: code ? '' : '还没有菜单。让下厨的人把他的二维码或链接发给你。',
      name: U.store.get(KEY_NAME, '') || '',
      message: '',
      picks: {},
      /* 下厨的人提供的外卖 / 下馆子选项：勾了哪些（存的是选项 id） */
      takeoutPicks: {},
      /* 自己加的条目：菜单上没有、但我就是想吃 / 想点外卖 / 想去店里吃 */
      wants: [],
      /* 纯界面态，不进草稿：当前开着哪个面板、输入框里还没提交的字 */
      _ownKind: 'dish',
      _ownDraft: {},
      sent: null,
      /* 生成好的点单。生成和"发给下厨的人"是两步，中间要是切走再回来
         （或者顺手刷新了一下），这三样还得在，不能让人白点一次生成。 */
      sendPayload: '',
      sendLink: '',
      sendQr: '',
      submitting: false,
      loadedCode: '',
    };
  }

  async function load(code) {
    const s = gs();
    const raw = String(code || '').trim();
    if (!raw) { s.error = '没有拿到菜单内容。'; return; }

    const key = SH.sig(raw);
    if (s.loadedCode === key && s.menu) return;

    s.code = raw;
    s.codeKey = key;
    s.loading = true;
    s.error = '';
    renderView();

    try {
      /* 旧的 6 位菜单码是存在服务器上的，而站里已经没有服务器了。
         这种情况要明确告诉人怎么办，不能让人对着"打不开"发呆。 */
      if (raw.charAt(0) !== '~') {
        throw new Error('这是一个旧版的 6 位菜单码，现在不用了 —— 让下厨的人把他的二维码或链接重新发给你。');
      }
      const menu = await SH.unpack(raw);
      if (!menu || !Array.isArray(menu.dishes)) throw new Error('这份菜单里没有内容。');
      s.menu = menu;
      s.kid = (typeof menu.k === 'string' && /^[A-Za-z0-9_-]{8,40}$/.test(menu.k)) ? menu.k : '';
      s.loadedCode = key;

      /* 恢复本机草稿与上次生成的那份点单 */
      const d = U.store.get(draftKey(key), null);
      if (d && typeof d === 'object') {
        s.picks = d.picks || {};
        s.takeoutPicks = (d.takeoutPicks && typeof d.takeoutPicks === 'object') ? d.takeoutPicks : {};
        s.message = d.message || '';
        s.wants = Array.isArray(d.wants) ? d.wants : [];
        if (d.name) s.name = d.name;
      }
      s.sent = U.store.get(sentKey(key), null);
      /* 上次生成过的话，那段内容和链接一并恢复出来 —— 不用为了"再发一次"重新点一遍 */
      if (s.sent && s.sent.payload) {
        s.sendPayload = s.sent.payload;
        s.sendLink = SH.orderLink(s.sent.payload);
      }
    } catch (e) {
      s.menu = null;
      s.error = U.errText(e);
    } finally {
      s.loading = false;
      renderView();
    }
  }

  function renderView() {
    const host = document.getElementById('view');
    if (host) render(host);
  }

  function saveDraft() {
    const s = gs();
    if (!s.codeKey) return;
    U.store.set(draftKey(s.codeKey), {
      picks: s.picks, takeoutPicks: s.takeoutPicks,
      message: s.message, name: s.name, wants: s.wants,
    });
    U.store.set(KEY_NAME, s.name || '');
    const el = document.getElementById('guest-save-state');
    if (el) { el.textContent = '草稿已存在这台设备上'; el.className = 'save-state saved'; }
  }

  const saveDraftSoon = U.debounce(saveDraft, 600);

  /* ---------- 渲染 ---------- */

  function render(host) {
    const s = gs();

    if (s.loading && !s.menu) {
      host.innerHTML = '<div class="wrap wrap-narrow"><div class="card">' +
        '<div class="skeleton" style="width:45%;height:20px"></div>' +
        '<div class="skeleton" style="width:70%"></div>' +
        '<div class="skeleton" style="width:55%"></div>' +
        '</div></div>';
      return;
    }

    if (s.error) {
      host.innerHTML = '<div class="wrap wrap-narrow">' +
        '<h1>打不开这份菜单</h1>' +
        '<div class="card"><div class="note-bar err">' + U.esc(s.error) + '</div>' +
        '<div class="field"><label>把下厨的人发来的链接粘到这里</label>' +
        '<div class="join-row" style="margin:0">' +
        '<input type="text" id="join-code" placeholder="整条链接，或者分享来的那段内容">' +
        '<button class="btn btn-primary" id="btn-join">打开</button>' +
        '</div>' +
        '<p class="hint">一整段话也行 —— 里面夹着链接我们也能认出来。</p>' +
        '</div>' +
        '<div class="btn-row" style="margin-top:14px"><a class="btn" href="#/">回首页</a></div>' +
        '</div></div>';
      return;
    }

    if (!s.menu) { host.innerHTML = ''; return; }

    const dishes = Array.isArray(s.menu.dishes) ? s.menu.dishes : [];
    /* 下厨的人提供的外卖 / 店里选项。只留他说"给点菜的人看"的那些。 */
    const takeouts = (Array.isArray(s.menu.takeouts) ? s.menu.takeouts : []).filter(function (t) {
      return t && t.selected !== false && (t.shop || t.item);
    });
    /* 他改了菜单、把某个选项撤掉之后，本机草稿里可能还留着已经不存在的 id。
       这里对一次，免得计数跟实际能提交的对不上。 */
    const tkIds = {};
    takeouts.forEach(function (t) { tkIds[String(t.id)] = 1; });
    const tkPicked = Object.keys(s.takeoutPicks || {}).filter(function (k) {
      return s.takeoutPicks[k] && tkIds[k];
    });
    const pickedCount = Object.keys(s.picks).filter(function (k) { return Number(s.picks[k]) > 0; }).length +
                        s.wants.length + tkPicked.length;

    let h = '<div class="wrap wrap-narrow">';

    h += '<h1>' + U.esc(s.menu.title || '今天的菜单') + '</h1>';
    h += '<p class="lede">' + U.esc(s.menu.cook_name || '下厨的人') + ' 列的菜单' +
         (s.menu.people ? ' · 按 ' + U.esc(s.menu.people) + ' 人份准备' : '') + '</p>';

    if (s.menu.note) {
      h += '<div class="note-bar">' + U.esc(s.menu.note) + '</div>';
    }

    if (s.sent) {
      h += '<div class="note-bar' + (s.sent.viaServer ? ' ok' : '') + '">你在 ' +
           U.esc(U.fmtTime(s.sent.at)) + ' 生成过这份点单：' +
           U.esc((s.sent.items || []).map(function (x) { return x.name; }).join('、')) +
           '。' +
           (s.sent.viaServer
             ? '<b>已经发到下厨的人那里了。</b>'
             : '改动之后再生成一次，就是新的一条。') +
           (s.sent.message ? '<br>你留的话：' + U.esc(s.sent.message) : '') +
           '</div>';
    }

    /* 菜单上一道菜都没有时，仍然让人能提交自己想吃的东西 */
    if (!dishes.length && !s.wants.length && !takeouts.length) {
      h += '<div class="card"><div class="empty"><div class="big">🥢</div>' +
           '<p>这份菜单还没有菜。你也可以在下面自己加想吃的。</p></div></div>';
    }

    h += '<div class="card">' +
           '<div class="row">' +
             '<div class="grow"><label style="font-size:13px;font-weight:600;display:block;margin-bottom:5px">你叫什么（下厨的人会看到）</label>' +
               '<input type="text" id="guest-name" data-field="guestName" value="' + U.esc(s.name) + '" placeholder="如 胥安"></div>' +
           '</div>' +
           '<div class="hint" style="margin-top:8px">点星星表示想吃的程度，再点一下同一颗可以取消。</div>' +
         '</div>';

    if (dishes.length) {
      h += '<div style="margin-top:18px">';
      dishes.forEach(function (d) { h += guestDishHtml(d); });
      h += '</div>';
    }

    /* ---- 下厨的人说这顿也可以点外卖 / 出去吃 ---- */
    if (takeouts.length) {
      h += '<div class="card" id="takeout-card" style="margin-top:18px">';
      h += U.takeoutHtml(takeouts, {
        head: (s.menu.cook_name || '下厨的人') + ' 说这顿也可以点这些',
        sub: '不想吃家里做的话，直接勾上你要的 —— 生成点单的时候会一起告诉' +
             (s.menu.cook_name || '下厨的人') + '。',
        pickable: true,
        picked: s.takeoutPicks,
      });
      h += '</div>';
    }

    /* ---- 菜单上没有的：自己加 ---- */
    h += '<div class="add-own" id="add-own">';
    h += '<div class="add-own-head"><h2>菜单上没有的，我自己加</h2></div>';

    h += '<div class="own-tabs" id="own-tabs">' +
           '<button type="button" class="own-tab' + (s._ownKind !== 'takeout' ? ' is-on' : '') + '" data-own-kind="dish">想吃一道菜</button>' +
           '<button type="button" class="own-tab' + (s._ownKind === 'takeout' ? ' is-on' : '') + '" data-own-kind="takeout">点外卖 / 去店里吃</button>' +
         '</div>';

    /* 面板一：自己想吃的一道菜 */
    h += '<div class="own-pane" data-pane="dish"' + (s._ownKind === 'takeout' ? ' hidden' : '') + '>' +
           '<div class="own-row">' +
             '<input type="text" id="own-dish-name" maxlength="24" placeholder="菜名，如 麻婆豆腐">' +
             '<input type="text" id="own-dish-from" maxlength="24" placeholder="想在哪吃 / 谁做（可以不填）">' +
           '</div>' +
           '<textarea id="own-dish-note" rows="2" maxlength="80" placeholder="想说的话，如 少放辣、要很嫩的那种（可以不填）"></textarea>' +
           '<div class="own-acts"><button type="button" class="btn btn-primary btn-sm" id="own-dish-add">加到我的清单</button></div>' +
         '</div>';

    /* 面板二：外卖 / 下馆子 */
    h += '<div class="own-pane" data-pane="takeout"' + (s._ownKind === 'takeout' ? '' : ' hidden') + '>' +
           '<div class="own-row">' +
             '<input type="text" id="own-tk-shop" maxlength="30" placeholder="店名 / 平台，如 楼下的川菜馆、美团上的那家">' +
             '<input type="text" id="own-tk-item" maxlength="30" placeholder="想吃的商品，如 香辣鸡腿堡套餐">' +
           '</div>' +
           '<div class="own-row">' +
             '<input type="text" id="own-tk-where" maxlength="40" placeholder="怎么吃，如 点外卖送到家 / 一起去店里吃（可以不填）">' +
             '<input type="text" id="own-tk-price" maxlength="16" placeholder="大概多少钱（可以不填）">' +
           '</div>' +
           '<textarea id="own-tk-note" rows="2" maxlength="80" placeholder="想说的话（可以不填）"></textarea>' +
           '<div class="own-acts"><button type="button" class="btn btn-primary btn-sm" id="own-tk-add">加到我的清单</button></div>' +
         '</div>';

    if (s.wants.length) {
      h += '<div class="own-list"><div class="own-list-head">我加的 <b>' + s.wants.length + '</b> 条</div>';
      s.wants.forEach(function (w) {
        h += '<div class="own-item">' +
               '<div class="own-item-main">' +
                 (w.kind === 'takeout'
                   ? '<span class="takeout-tag">外卖 / 店里</span>'
                   : '<span class="own-tag">菜单外</span>') +
                 '<span class="own-item-name">' + U.esc(w.name) + '</span>' +
                 (w.from ? '<span class="own-item-from">' + U.esc(w.from) + '</span>' : '') +
                 (w.price ? '<span class="own-item-price">' + U.esc(w.price) + '</span>' : '') +
                 (w.note ? '<span class="own-item-note">' + U.esc(w.note) + '</span>' : '') +
               '</div>' +
               '<button type="button" class="btn btn-sm btn-ghost" data-own-remove="' + U.esc(w.id) + '">去掉</button>' +
             '</div>';
      });
      h += '</div>';
    } else {
      h += '<div class="own-acts" style="margin-top:12px"><button type="button" class="btn btn-primary btn-sm" id="own-to-list">加到我的清单</button></div>';
    }

    h += '</div>';

    h += '<div class="card">';
    h += '<div class="card-head"><h2>想跟下厨的人说点什么</h2></div>';
    h += '<textarea data-field="guestMessage" rows="3" placeholder="如 想加个汤 / 少放辣 / 大概七点吃">' + U.esc(s.message) + '</textarea>';
    h += '</div>';

    /* 生成点单条 */
    h += '<div class="card">';
    h += '<div class="card-head"><h2>生成点单</h2><div class="spacer"></div>' +
         '<span class="save-state" id="guest-save-state"></span></div>';

    if (!pickedCount) {
      h += '<div class="note-bar warn">还没选菜。给想吃的菜点几颗星，或者自己加一条，再生成。</div>';
    } else {
      const nMenu = pickedCount - s.wants.length - tkPicked.length;
      const bits = [];
      if (nMenu) bits.push('<b>' + nMenu + '</b> 道菜单上的菜');
      if (tkPicked.length) bits.push('<b>' + tkPicked.length + '</b> 个外卖 / 店里选项');
      if (s.wants.length) bits.push('<b>' + s.wants.length + '</b> 条你自己加的');
      h += '<div class="note-bar">已选 ' + bits.join('，') + '。</div>';
    }

    h += '<div class="btn-row">' +
         '<button class="btn btn-primary" id="btn-submit"' + (s.submitting || !pickedCount ? ' disabled' : '') + '>' +
         (s.submitting ? '<span class="spinner"></span>正在生成…' : '生成点单给 ' + U.esc(s.menu.cook_name || '下厨的人')) + '</button>' +
         '<button class="btn" id="btn-save-draft">保存草稿</button>' +
         '<button class="btn btn-ghost" id="btn-clear-picks">清空我的选择</button>' +
         '</div>';
    h += '</div>';

    /* 生成好的点单显眼地摆在这儿：复制走、发微信 —— 这是把点单送到
       下厨的人手上的唯一一条路，所以它得是个大按钮，而不是一行小字。 */
    if (s.sendPayload) {
      /* 提交其实已经成功了，但"送没送到"是另一回事：
         下厨的人那边配了收单服务，这一条在他开页面时就自己进去了；
         没配（或者他手上是旧链接）就还得走手动那条路。
         同一张卡按这个分两种长相 —— 自动送到的就不用再让人多做一个动作。 */
      const via = !!(s.sent && s.sent.viaServer);
      if (!s.sendQr) s.sendQr = SH.qrDataUrl(s.sendPayload, 560);

      /* 手动那套（复制链接 / 复制文字 / 二维码）在两种形态下都要在，
         只是自动送到的形态里它收进一个折叠里当备用。 */
      let manual = '<div class="btn-row">' +
           '<button class="btn btn-primary" id="btn-send-order">复制，发给下厨的人</button>' +
           '<button class="btn" id="btn-send-text">复制成文字版</button>' +
           '</div>';
      if (s.sendQr) {
        manual += '<details class="send-qr"><summary>或者：让他扫这个二维码</summary>' +
             '<div class="qr-box qr-box-sm"><img src="' + s.sendQr + '" alt="点单二维码"></div>' +
             '<p class="hint" style="text-align:center">面对面的时候最省事：他拿手机扫一下，点单就直接进他那边了。</p>' +
             '</details>';
      }

      h += '<div class="card send-card' + (via ? ' send-card-ok' : '') + '">';
      if (via) {
        h += '<div class="card-head"><h2>已经发给下厨的人了</h2></div>';
        h += '<p class="hint">他那边打开「收到的点单」就能看到你点的菜，这一步不用再做了。</p>';
        h += '<details class="send-fallback"><summary>他没收到？再手动发一条</summary>' +
             '<p class="hint" style="margin:10px 0 8px">把下面这段发给他，' +
             '他粘进「收到的点单」里一样能收。</p>' + manual + '</details>';
      } else {
        h += '<div class="card-head"><h2>最后一步：发给下厨的人</h2></div>';
        h += '<p class="hint">点下面的按钮把内容复制下来，用微信发给他。' +
             '他打开就能看到你点的菜 —— 也不怕发不出去。</p>';
        h += manual;
      }
      h += '</div>';
    }

    h += '<div class="btn-row" style="margin-top:18px;justify-content:center"><a class="btn btn-ghost" href="#/">回首页</a></div>';
    h += '</div>';

    host.innerHTML = h;
    const st = document.getElementById('guest-save-state');
    if (st && U.store.get(draftKey(s.codeKey), null)) {
      st.textContent = '草稿已存在这台设备上';
      st.className = 'save-state saved';
    }
    /* 把上一次没提交完的输入放回去（只在字段还空着时填，
       避免盖掉用户在这次渲染里刚打进去的字）。 */
    const keep = s._ownDraft || {};
    Object.keys(keep).forEach(function (id) {
      const el = document.getElementById(id);
      if (el && !el.value && keep[id]) el.value = keep[id];
    });
  }

  function guestDishHtml(d) {
    const s = gs();
    const stars = Number(s.picks[d.id]) || 0;
    const missing = (d.materials || []).filter(function (m) { return m.have === false; });

    let h = '<div class="dish-card' + (stars > 0 ? ' is-picked' : '') + '">';
    h += '<div class="dish-top"><h3 class="dish-name">' + U.esc(d.name) + '</h3><div class="dish-meta">';
    if (d.cuisine) h += '<span class="chip">' + U.esc(d.cuisine) + '</span>';
    if (d.difficulty) h += '<span class="chip">' + U.esc(d.difficulty) + '</span>';
    if (d.timeMinutes) h += '<span class="chip">约 ' + d.timeMinutes + ' 分钟</span>';
    if (d.source === 'custom') h += '<span class="chip chip-primary">下厨的人自己的料理</span>';
    h += '</div></div>';

    /* 参考图：下厨的人自己贴的优先，没贴就标他挑定的那份教程 */
    h += U.imageHtml(d);

    if (d.materials && d.materials.length) {
      h += '<div class="mat-list">';
      d.materials.forEach(function (m) {
        h += '<span class="mat' + (m.have === false ? ' miss' : '') + '">' +
             U.esc(m.name) +
             '<span class="mat-type">' + U.esc(m.type || '') + '</span>' +
             (m.amount ? '<span class="mat-amount">' + U.esc(m.amount) + '</span>' : '') +
             '</span>';
      });
      h += '</div>';
    }

    if (missing.length) {
      h += '<div class="note-bar warn" style="margin:11px 0 0">下厨的人还要去买：' +
           missing.map(function (m) { return U.esc(m.name); }).join('、') + '</div>';
    }

    if (d.steps && d.steps.length) {
      h += '<details class="steps"><summary>做法 ' + d.steps.length + ' 步</summary><ol>' +
           d.steps.map(function (x) { return '<li>' + U.esc(x) + '</li>'; }).join('') +
           '</ol></details>';
    }
    if (d.tips) h += '<div class="tips">小技巧：' + U.esc(d.tips) + '</div>';

    h += U.factsHtml(d);

    h += '<div class="dish-actions">';
    h += '<div class="stars" data-dish="' + d.id + '">' +
         U.starsHtml(stars, { emptyLabel: '不点这道' }) +
         '</div>';
    h += '</div>';

    h += U.tutorialHtml(d);

    h += '</div>';
    return h;
  }

  /* ---------- 交互 ---------- */

  /* 同下厨端：监听器挂 document，不挂在路由容器上。
     容器每次进路由都会换成全新节点，挂在它上面的监听器会跟着一起失效 ——
     表现就是「星星点不动、按钮没反应，还不报错」。 */
  let docBound = false;

  function bind() {
    if (docBound) return;
    docBound = true;
    document.addEventListener('click', onDocClick);
    document.addEventListener('input', onGuestInput);
    document.addEventListener('change', onGuestInput);
  }

  function onDocClick(e) {
    if (!e.target || !e.target.closest || !e.target.closest('#view')) return;

    /* 星级：点已选中的那颗＝取消 */
    const star = e.target.closest('[data-star]');
    if (star) {
      if (window.KF.state.route.name !== 'guest' || !gs()) return;
      if (star.disabled) return;
      const wrap = star.closest('[data-dish]');
      if (!wrap) return;
      const id = wrap.dataset.dish;
      const hit = Number(star.dataset.star);
      const s = gs();
      const cur = Number(s.picks[id]) || 0;
      const next = cur === hit ? 0 : hit;
      if (next > 0) s.picks[id] = next; else delete s.picks[id];

      const card = wrap.closest('.dish-card');
      /* 只换里面的星，不换外层节点，否则 data-dish 会丢，后续点击就失效 */
      wrap.innerHTML = U.starsHtml(next, { emptyLabel: '不点这道' });
      if (card) card.classList.toggle('is-picked', next > 0);

      /* 外卖勾选和星星共用同一套计数更新，改一处就够了 */
      refreshSubmitBar();
      saveDraftSoon();
      return;
    }

    const btn = e.target.closest('button');
    if (!btn) return;

    /* 这个按钮跟当前这份菜单无关（它是"打不开"那一屏里的入口），先处理 */
    if (btn.id === 'btn-join') { goFromInput(); return; }

    if (window.KF.state.route.name !== 'guest' || !gs()) return;

    /* 自己加的条目：切换两种、提交一条、删掉一条 */
    if (btn.dataset.ownKind) { switchOwnKind(btn.dataset.ownKind); return; }
    if (btn.id === 'own-dish-add') { addDishWant(); return; }
    if (btn.id === 'own-tk-add') { addTakeoutWant(); return; }
    if (btn.dataset.ownRemove) { removeWant(btn.dataset.ownRemove); return; }

    if (btn.id === 'btn-save-draft') { saveDraft(); U.toast('草稿已保存在这台设备上', 'ok'); return; }
    if (btn.id === 'btn-clear-picks') {
      const s = gs();
      s.picks = {};
      s.takeoutPicks = {};
      s.message = '';
      s.wants = [];
      saveDraft();
      renderView();
      U.toast('已清空');
      return;
    }
    if (btn.id === 'btn-submit') { submit(); return; }
    if (btn.id === 'btn-send-order') { sendOrder(btn); return; }
    if (btn.id === 'btn-send-text') { sendOrderText(btn); return; }
    if (btn.dataset.act === 'open-tutorial') {
      /* 点菜端更要小心：这是别人（下厨的人）存进去的链接，
         而云端数据可能是很久以前存的，里面可能已经混进出事的站点。
         一律过 AI.safeUrl 安检，绝不把可疑来源送到点菜的人的浏览器里。 */
      const raw = btn.dataset.url;
      const safe = AI.safeUrl(btn.dataset.dish || '', raw);
      if (safe !== raw) U.toast('这个来源已不可用，已换成安全搜索');
      /* 自己填的来源没经过任何核实，点菜的人也该知道这一点 ——
         这条提示以前只在下厨端有，点菜端点了是没有任何说明的。 */
      else if (btn.dataset.own === '1') U.toast('这是下厨的人自己填的来源，我们没验证过内容');
      window.open(safe, '_blank', 'noopener,noreferrer');
      return;
    }
  }

  /* ---------- 自己加的条目 ---------- */

  /* 两条面板互斥显示。只切 hidden 和类名，不重画整页 ——
     重画会把已经填了一半的输入框清掉。 */
  function switchOwnKind(kind) {
    const s = gs();
    s._ownKind = kind;
    const tabs = document.querySelectorAll('.own-tab');
    for (let i = 0; i < tabs.length; i++) {
      tabs[i].classList.toggle('is-on', tabs[i].dataset.ownKind === kind);
    }
    const panes = document.querySelectorAll('.own-pane');
    for (let i = 0; i < panes.length; i++) {
      panes[i].hidden = panes[i].dataset.pane !== kind;
    }
  }

  /* 名称/店名里塞网址没有意义，还可能被当成来源；直接拒掉。
     这些内容会原样进云端再显示给下厨的人，所以要在这里就掐住。 */
  function cleanText(v, max) {
    let t = String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
    t = t.replace(/\s+/g, ' ');
    if (/https?:\/\/|www\.|\.[a-z]{2,6}\//i.test(t)) t = t.replace(/https?:\/\/\S*/gi, '').trim();
    return t.slice(0, max);
  }

  function addWant(w, usedIds) {
    const s = gs();
    if (s.wants.length >= 20) { U.toast('最多加 20 条', 'err'); return false; }
    const dup = s.wants.some(function (x) {
      return x.kind === w.kind && x.name === w.name && (x.from || '') === (w.from || '');
    });
    if (dup) { U.toast('这条已经在清单里了', 'err'); return false; }
    rememberOwnForm(usedIds);
    s.wants.push(w);
    saveDraft();
    renderView();
    /* 刚加完，把新条目滚进视野，否则用户不知道加成功了 */
    resumeOwnForm();
    return true;
  }

  /* 加完一条要重画列表，但重画会把正在填的输入框一起清掉 ——
     想连着加两条的人会以为第一遍白填了。
     所以记住"当前没提交的那一栏"里已填的内容，重画后放回去；
     刚提交过的那一栏要显式清掉，不然提交完还挂着上次的字。 */
  function rememberOwnForm(usedIds) {
    const s = gs();
    const all = ['own-dish-name', 'own-dish-from', 'own-dish-note',
                 'own-tk-shop', 'own-tk-item', 'own-tk-where', 'own-tk-price', 'own-tk-note'];
    const used = usedIds || [];
    const keep = Object.assign({}, s._ownDraft || {});
    all.forEach(function (id) {
      const el = document.getElementById(id);
      if (!el) return;
      if (used.indexOf(id) >= 0) delete keep[id];      /* 刚用掉的，不要留着 */
      else if (el.value) keep[id] = el.value;          /* 还没提交的，留着 */
    });
    s._ownDraft = keep;
  }

  function resumeOwnForm() {
    const s = gs();
    switchOwnKind(s._ownKind || 'dish');
    const box = document.getElementById('add-own');
    if (box) box.scrollIntoView({ block: 'nearest' });
  }

  function addDishWant() {
    const nameEl = document.getElementById('own-dish-name');
    const name = cleanText(nameEl && nameEl.value, 24);
    if (!name) { U.toast('先写个菜名', 'err'); if (nameEl) nameEl.focus(); return; }

    const ok0 = addWant({
      id: U.uid(),
      kind: 'dish',
      name: name,
      from: cleanText(document.getElementById('own-dish-from') && document.getElementById('own-dish-from').value, 24),
      note: cleanText(document.getElementById('own-dish-note') && document.getElementById('own-dish-note').value, 80),
      price: '',
    }, ['own-dish-name', 'own-dish-from', 'own-dish-note']);
    if (ok0) U.toast('加进去了', 'ok');
  }

  function addTakeoutWant() {
    const shopEl = document.getElementById('own-tk-shop');
    const itemEl = document.getElementById('own-tk-item');
    const shop = cleanText(shopEl && shopEl.value, 30);
    const item = cleanText(itemEl && itemEl.value, 30);
    if (!shop && !item) { U.toast('至少写个店名或者想吃的商品', 'err'); if (shopEl) shopEl.focus(); return; }

    const ok0 = addWant({
      id: U.uid(),
      kind: 'takeout',
      name: item || shop,
      from: shop,
      where: cleanText(document.getElementById('own-tk-where') && document.getElementById('own-tk-where').value, 40),
      price: cleanText(document.getElementById('own-tk-price') && document.getElementById('own-tk-price').value, 16),
      note: cleanText(document.getElementById('own-tk-note') && document.getElementById('own-tk-note').value, 80),
    }, ['own-tk-shop', 'own-tk-item', 'own-tk-where', 'own-tk-price', 'own-tk-note']);
    if (ok0) U.toast('加进去了', 'ok');
  }

  function removeWant(id) {
    const s = gs();
    s.wants = s.wants.filter(function (w) { return w.id !== id; });
    saveDraft();
    renderView();
    U.toast('去掉了');
  }

  function onGuestInput(e) {
    if (window.KF.state.route.name !== 'guest' || !gs()) return;
    const el = e.target;
    if (!el || !el.dataset) return;
    const s = gs();
    const f = el.dataset.field;
    if (f === 'guestName') { s.name = el.value; saveDraftSoon(); return; }
    if (f === 'guestMessage') { s.message = el.value; saveDraftSoon(); return; }
    /* 下厨的人列的外卖选项：勾选走 change，这里能收到。
       只更新计数和提交按钮，不重画 —— 重画会把勾好的框闪一下。 */
    if (f === 'takeoutPick') {
      const key = String(el.dataset.key || '');
      if (!key) return;
      if (el.checked) s.takeoutPicks[key] = 1;
      else delete s.takeoutPicks[key];
      refreshSubmitBar();
      saveDraftSoon();
      return;
    }
  }

  /* 跟着"选了什么"更新提交条，不重画整页。
     星星和外卖勾选都走这里，省得两处各写一套、改一处漏一处。 */
  function refreshSubmitBar() {
    const s = gs();
    const menu = s.menu || {};
    const dishes = Array.isArray(menu.dishes) ? menu.dishes : [];
    let nMenu = 0;
    dishes.forEach(function (d) {
      if (Number(s.picks[d.id]) > 0) nMenu++;
    });
    const tkList = (Array.isArray(menu.takeouts) ? menu.takeouts : []).filter(function (t) {
      return t && t.selected !== false && (t.shop || t.item);
    });
    let nTk = 0;
    tkList.forEach(function (t) { if (s.takeoutPicks[String(t.id)]) nTk++; });
    const total = nMenu + nTk + s.wants.length;

    const bar = document.getElementById('btn-submit');
    if (bar) {
      bar.disabled = !total || s.submitting;
      bar.textContent = s.submitting ? '正在生成…' : '生成点单给 ' + (menu.cook_name || '下厨的人');
    }

    const bars = document.querySelectorAll('.card .note-bar');
    for (let i = 0; i < bars.length; i++) {
      if (!/已选|还没选菜/.test(bars[i].textContent)) continue;
      bars[i].className = 'note-bar' + (total ? '' : ' warn');
      if (!total) {
        bars[i].textContent = '还没选菜。给想吃的菜点几颗星，或者自己加一条，再生成。';
        continue;
      }
      const bits = [];
      if (nMenu) bits.push('<b>' + nMenu + '</b> 道菜单上的菜');
      if (nTk) bits.push('<b>' + nTk + '</b> 个外卖 / 店里选项');
      if (s.wants.length) bits.push('<b>' + s.wants.length + '</b> 条你自己加的');
      bars[i].innerHTML = '已选 ' + bits.join('，') + '。';
    }
  }

  function onKeydown(e) {
    if (e.target && e.target.id === 'join-code' && e.key === 'Enter') {
      e.preventDefault();
      goFromInput();
    }
  }

  /* 粘贴进来的可能是整条链接、一整段带话的消息，也可能只是旧的 6 位码。
     统一交给 share 层去认。这里绝不能做 toUpperCase ——
     载荷里的大小写是有意义的，转一次就把整份菜单毁了。 */
  function goFromInput() {
    const el = document.getElementById('join-code');
    const code = SH.codeFrom(el ? el.value : '');
    if (!code) { U.toast('先把下厨的人发来的那条内容粘进来', 'err'); return; }
    location.hash = '#/m/' + code;
  }

  async function submit() {
    const s = gs();
    if (s.submitting) return;

    const items = [];
    const dishes = (s.menu && s.menu.dishes) || [];
    dishes.forEach(function (d) {
      const stars = Number(s.picks[d.id]) || 0;
      if (stars > 0) items.push({ dish_id: d.id, name: d.name, stars: stars });
    });

    /* 自己加的条目：跟菜单上的菜同一个数组、同一套结构，
       只多一个 kind 用来区分。服务端不需要改 —— items 本来就是自由 JSONB。 */
    s.wants.forEach(function (w) {
      items.push({
        dish_id: '',
        name: w.name,
        stars: 0,
        kind: w.kind === 'takeout' ? 'takeout' : 'wish',
        from: w.from || '',
        where: w.where || '',
        price: w.price || '',
        note: w.note || '',
      });
    });

    /* 下厨的人自己提供的外卖 / 店里选项。勾了哪几个就报哪几个 ——
       名称和店名从菜单上取（不信任草稿里存的那份，菜单才是最新的），
       这样下厨的人改过之后，收到的点单跟当前菜单是一致的。 */
    const tkList = (s.menu && Array.isArray(s.menu.takeouts) ? s.menu.takeouts : []).filter(function (t) {
      return t && t.selected !== false && (t.shop || t.item);
    });
    tkList.forEach(function (t) {
      if (!s.takeoutPicks[String(t.id)]) return;
      items.push({
        dish_id: '',
        name: t.item || t.shop || '',
        stars: 0,
        /* 还是 takeout 这一类，但 from 标成"他自己列的"，
           下厨端一看就知道"这是我摆出来的那个选项被勾了"，
           而不是别人另外写的一条。 */
        kind: 'takeout',
        from: t.shop || '',
        where: t.where || '',
        price: t.price || '',
        note: t.note || '',
        offered_by_cook: true,
      });
    });

    if (!items.length) { U.toast('还没选菜，也没加想吃的', 'err'); return; }

    s.submitting = true;
    renderView();

    try {
      const me = (s.name || '').trim() || '匿名';
      /* 只带下厨的人真的要看的字段。dish_id 是站内用的，
         带上它每条要多十几个字符，而对面的界面根本不显示它。 */
      const slim = items.map(function (it) {
        return {
          name: it.name,
          stars: Number(it.stars) || 0,
          kind: it.kind || '',
          from: it.from || '',
          where: it.where || '',
          price: it.price || '',
          note: it.note || '',
        };
      });

      const msg = (s.message || '').trim();
      const at = new Date().toISOString();
      const order = { v: 1, id: U.uid(), at: at, guest: me, items: slim, message: msg };

      /* 先把链接那条路做出来 —— 不管发生什么它都要有。
         后端那条路是"顺带"，不能让打包等它。 */
      const payload = await SH.pack(order);

      /* 再顺手交给后端。成不成都不影响下面：
         成了下厨的人那边立刻就看到；不成他照样能点「复制」把这条发出去。 */
      let posted = false;
      if (s.kid) {
        try { posted = await NET.postOrder(s.kid, order); }
        catch (e) { posted = false; }
      }

      s.sendPayload = payload;
      s.sendLink = SH.orderLink(payload);
      s.sendQr = '';      /* 等渲染时再画，别让"生成"这一步在这儿卡一下 */
      s.sent = {
        at: at,
        payload: payload,
        items: items,
        message: msg,
        /* 记下来，刷新页面之后这张卡还说得出"已经发过去了" */
        viaServer: posted,
      };
      U.store.set(sentKey(s.codeKey), s.sent);
      U.store.set(KEY_NAME, s.name || '');

      s.submitting = false;
      renderView();
      U.toast(posted ? '已经发给下厨的人了' : '点单生成好了，点「复制，发给下厨的人」', 'ok');
      /* 生成完把最后那一步滚进视野。少了这一下，很多人会以为已经发出去了 */
      const card = document.querySelector('.send-card');
      if (card) card.scrollIntoView({ block: 'center' });
    } catch (e) {
      s.submitting = false;
      renderView();
      U.toast(U.errText(e), 'err');
    }
  }

  /* ---------- 把点单发给下厨的人 ---------- */

  /* 除了链接还给一段人能读的话：微信里并不是任何长链接都会被当成可点的链接，
     把链接和这段话一起发过去最稳，对方照着念也知道收到的是什么。 */
  function orderText() {
    const s = gs();
    if (!s.sendLink) return '';
    const items = (s.sent && s.sent.items) || [];
    const parts = items.map(function (it) {
      if (it.kind === 'takeout') return it.name + (it.from ? '（' + it.from + '）' : '');
      if (it.kind === 'wish') return it.name + '（菜单上没有的）';
      const n = Number(it.stars) || 0;
      return it.name + (n ? '（' + (U.starLabels[n] || '') + '）' : '');
    });
    return '【吃什么·点单】' + ((s.name || '').trim() || '匿名') + ' 点好了：' +
      parts.join('、') + '。' +
      ((s.sent && s.sent.message) ? '留言：' + s.sent.message + '。' : '') +
      '打开就能看到：';
  }

  function copySend(text, okMsg, failTitle, btn) {
    const label = btn ? btn.textContent : '';
    if (btn) { btn.disabled = true; btn.textContent = '正在复制…'; }
    U.copyText(text).then(function () {
      U.toast(okMsg, 'ok');
    }, function () {
      U.manualCopy(text, failTitle);
    }).then(function () {
      if (btn) { btn.disabled = false; btn.textContent = label; }
    });
  }

  function sendOrder(btn) {
    const s = gs();
    if (!s.sendLink) { U.toast('先点「生成点单」', 'err'); return; }
    copySend(s.sendLink, '已复制。粘到微信里发给下厨的人就行', '复制点单链接', btn);
  }

  function sendOrderText(btn) {
    const s = gs();
    if (!s.sendLink) { U.toast('先点「生成点单」', 'err'); return; }
    copySend(orderText() + s.sendLink, '已复制，粘到微信里发出去就行', '复制点单文字版', btn);
  }

  window.KF.guest = {
    reset: reset,
    load: load,
    render: render,
    bind: bind,
    onKeydown: onKeydown,
  };
})();
