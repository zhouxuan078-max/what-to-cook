/* ==========================================================================
   通用工具层：转义、存储、提示、弹窗、星级、事件委托
   ========================================================================== */
window.KF = window.KF || {};

(function () {
  'use strict';

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function uid() {
    return Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-4);
  }

  /* 本机密钥：下厨的人的写权限凭证，只存在这台设备上 */
  function randToken(len) {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    const buf = new Uint8Array(len);
    if (window.crypto && window.crypto.getRandomValues) {
      window.crypto.getRandomValues(buf);
    } else {
      for (let i = 0; i < len; i++) buf[i] = Math.floor(Math.random() * 256);
    }
    let out = '';
    for (let i = 0; i < len; i++) out += chars[buf[i] % chars.length];
    return out;
  }

  const store = {
    get(k, def) {
      try {
        const v = window.localStorage.getItem(k);
        return v == null ? def : JSON.parse(v);
      } catch (e) { return def; }
    },
    set(k, v) {
      try { window.localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* 隐私模式忽略 */ }
    },
    del(k) {
      try { window.localStorage.removeItem(k); } catch (e) { /* 忽略 */ }
    },
  };

  function toast(msg, kind) {
    let box = document.querySelector('.toasts');
    if (!box) {
      box = document.createElement('div');
      box.className = 'toasts';
      document.body.appendChild(box);
    }
    const el = document.createElement('div');
    el.className = 'toast' + (kind ? ' ' + kind : '');
    el.textContent = msg;
    box.appendChild(el);
    setTimeout(function () {
      el.style.transition = 'opacity .26s';
      el.style.opacity = '0';
      setTimeout(function () { el.remove(); }, 280);
    }, 2800);
  }

  function openModal(innerHtml) {
    closeModal();
    const mask = document.createElement('div');
    mask.className = 'modal-mask';
    mask.innerHTML = '<div class="modal">' + innerHtml + '</div>';
    mask.addEventListener('mousedown', function (e) {
      if (e.target === mask) closeModal();
    });
    document.body.appendChild(mask);
    document.body.style.overflow = 'hidden';
    return mask.querySelector('.modal');
  }

  function closeModal() {
    const m = document.querySelector('.modal-mask');
    if (m) m.remove();
    document.body.style.overflow = '';
  }

  const STAR_LABELS = ['', '不太想', '可以吃', '还行', '想吃', '很想吃'];

  function starsHtml(value, opts) {
    opts = opts || {};
    value = Number(value) || 0;
    let h = '<span class="stars' + (opts.readonly ? ' readonly' : '') + '">';
    h += '<span class="star-row">';
    for (let i = 1; i <= 5; i++) {
      h += '<button type="button" class="star' + (i <= value ? ' on' : '') + '" data-star="' + i + '"' +
           (opts.readonly ? ' disabled' : '') +
           ' title="' + STAR_LABELS[i] + '" aria-label="' + STAR_LABELS[i] + '">★</button>';
    }
    h += '</span>';
    if (opts.showLabel !== false) {
      h += '<span class="star-label">' + (value ? STAR_LABELS[value] : (opts.emptyLabel || '未评分')) + '</span>';
    }
    h += '</span>';
    return h;
  }

  /* 星级点击：点已选中的星＝取消（回到 0） */
  function bindStars(root, getValue, setValue) {
    root.addEventListener('click', function (e) {
      const btn = e.target.closest('[data-star]');
      if (!btn || btn.disabled) return;
      const hit = Number(btn.dataset.star);
      const next = (Number(getValue()) === hit) ? 0 : hit;
      setValue(next);
    });
  }

  function fmtTime(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    const now = new Date();
    const pad = function (n) { return n < 10 ? '0' + n : '' + n; };
    const hm = pad(d.getHours()) + ':' + pad(d.getMinutes());
    const sameDay = d.toDateString() === now.toDateString();
    if (sameDay) return '今天 ' + hm;
    const y = new Date(now.getTime() - 86400000);
    if (d.toDateString() === y.toDateString()) return '昨天 ' + hm;
    return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + hm;
  }

  /* 带 cancel 的防抖。少了 cancel，saveNow() 里的“立刻保存”并不能取消
     待触发的定时器，900ms 后还会再存一次，白跑一趟网络。 */
  function debounce(fn, wait) {
    let t = null;
    function wrapped() {
      const args = arguments, self = this;
      clearTimeout(t);
      t = setTimeout(function () { t = null; fn.apply(self, args); }, wait);
    }
    wrapped.cancel = function () { clearTimeout(t); t = null; };
    wrapped.pending = function () { return t !== null; };
    return wrapped;
  }

  function delegate(root, selector, evt, handler) {
    root.addEventListener(evt, function (e) {
      const el = e.target.closest(selector);
      if (el && root.contains(el)) handler(e, el);
    });
  }

  /* 用 execCommand 这条老路。关键：它「失败也返回 false 而不是抛错」，
     不检查返回值就会谎报成功 —— 这正是「点了复制、提示成功、剪贴板里却什么都没有」。 */
  function legacyCopy(text) {
    let ok = false;
    let ta = null;
    try {
      ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.top = '0';
      ta.style.left = '0';
      ta.style.width = '1px';
      ta.style.height = '1px';
      ta.style.padding = '0';
      ta.style.border = 'none';
      ta.style.outline = 'none';
      ta.style.boxShadow = 'none';
      ta.style.background = 'transparent';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      try { ta.setSelectionRange(0, text.length); } catch (e2) { /* 忽略 */ }
      ok = document.execCommand('copy') === true;
    } catch (e) {
      ok = false;
    }
    if (ta && ta.parentNode) ta.parentNode.removeChild(ta);
    return ok;
  }

  /* 复制文本。三层降级，保证总有出路：
     1) navigator.clipboard.writeText —— 最干净，但要求 https + 文档有焦点。
        在被嵌进 iframe、或文档没被聚焦时会被直接拒绝（NotAllowedError）。
     2) execCommand('copy') —— 老办法，上面已经处理了它的返回值陷阱。
     3) 两层都失败 → 抛错，由调用方弹出「手动复制框」，绝不让用户白点。 */
  function copyText(text) {
    const str = String(text == null ? '' : text);

    if (navigator.clipboard && navigator.clipboard.writeText && window.isSecureContext) {
      try {
        return navigator.clipboard.writeText(str).then(
          function () { return true; },
          function () {
            if (legacyCopy(str)) return true;
            throw new Error('clipboard refused');
          }
        );
      } catch (e) {
        /* 少数浏览器 writeText 会同步抛错 */
        if (legacyCopy(str)) return Promise.resolve(true);
        return Promise.reject(e);
      }
    }

    if (legacyCopy(str)) return Promise.resolve(true);
    return Promise.reject(new Error('clipboard unavailable'));
  }

  /* 复制失败时的兜底：把要复制的东西摆出来让人自己复制，附带着已经选中。
     永远不要出现「点了没反应」——宁可多一步手动，也不能让人不知道发生了什么。 */
  function manualCopy(text, title) {
    const str = String(text == null ? '' : text);
    const modal = openModal(
      '<h3>' + esc(title || '手动复制') + '</h3>' +
      '<p class="small muted" style="margin:8px 0 0">这个浏览器没让页面自动写入剪贴板（常见于内嵌预览窗口）。' +
      '内容已经帮你选好了，直接按 <b>Ctrl + C</b>（Mac 按 <b>⌘ + C</b>）复制。</p>' +
      '<input type="text" id="manual-copy-input" readonly value="' + esc(str) + '" style="margin-top:14px">' +
      '<div class="btn-row" style="margin-top:14px"><button class="btn btn-primary" id="manual-copy-again">再试一次自动复制</button>' +
      '<button class="btn" id="manual-copy-close">关闭</button></div>'
    );

    const input = modal.querySelector('#manual-copy-input');
    const focusSel = function () {
      if (!input) return;
      input.focus();
      try { input.setSelectionRange(0, input.value.length); } catch (e) { /* 忽略 */ }
    };
    focusSel();
    if (input) input.addEventListener('click', focusSel);

    modal.querySelector('#manual-copy-close').addEventListener('click', closeModal);
    modal.querySelector('#manual-copy-again').addEventListener('click', function () {
      copyText(str).then(function () {
        toast('已复制到剪贴板', 'ok');
        closeModal();
      }, function () {
        toast('还是不行，请手动选中上面那行按 Ctrl+C', 'err');
        focusSel();
      });
    });
    return modal;
  }

  /* 教程入口按钮组：全是各菜谱站自己的搜索页，点开就是这道菜的结果列表。
     data-act="open-tutorial" 由各页面自己的点击处理器接住。

     data-dish 一定要带上：云端存的旧菜单里可能有已经出事、被赌博站接手的站点
     （香哈菜谱、心食谱都中过招），点击时要用菜名换成一次安全搜索。
     按钮还必须能换行——手机屏幕上好几个按钮挤一行会点错。 */
  function tutorialHtml(d) {
    const list = (d && d.tutorials) || [];
    if (!list.length) return '';
    const dish = (d && (d.name || d.title)) || '';
    const picked = (d && (d.tutorialPick || d.pickedTutorial)) || '';
    let h = '<div class="tut-block"><div class="tut-label">去哪学这道菜</div><div class="tut-row">';
    list.forEach(function (t) {
      const on = picked && picked === t.site;
      /* 用户自己填的那个来源要能一眼分出来：别的站是"我们建议的"，
         这个是他自己挑的，打开前该让他知道这是他的地址、
         我们对那个页面没有任何承诺。 */
      const own = t.kind === '自定';
      h += '<button type="button" class="btn btn-tut' +
           (on ? ' is-picked' : '') + (own ? ' is-own' : '') + '"' +
           ' data-act="open-tutorial"' +
           ' data-dish="' + esc(dish) + '"' +
           ' data-site="' + esc(t.site) + '"' +
           ' data-own="' + (own ? '1' : '') + '"' +
           ' data-id="' + esc((d && d.id) || '') + '"' +
           ' data-url="' + esc(t.url) + '">' +
           esc(own ? '你自己定的来源' : t.site) + '<i>' + esc(own ? '' : (t.kind || '')) + '</i> ↗</button>';
    });
    h += '</div>';
    if (picked) {
      h += '<div class="tut-picked">✓ 参考图用「' + esc(picked) + '」这份教程</div>';
    }
    h += '</div>';
    return h;
  }

  /* 图片地址的安检。只认 http/https，别的协议一律不放行 ——
     图片地址是可以随便填的，等于把一个"能写任意内容"的入口交给别人，
     再被渲染成 <img src> 就是把风险装进所有点开菜单的人的浏览器里。
     javascript:、data: 都是这么进来的，所以这里不看内容、只看协议。

     顺手复用同一份赌博站名单。ui.js 在 ai.js 之前加载，不能直接调 AI.isBlocked，
     所以这份名单在这里留一份 —— 两个文件里的名单必须保持一致。 */
  const IMG_BLOCKED_HOSTS = [
    'xiangha.com',      /* 已被赌博站接手 */
    'xinshipu.com',     /* 首页被挂马，跳转赌博页 */
    'meishij.net',      /* 手机端跳赌博页（电脑端 404 —— 双面站点） */
    'meishij.com',
    'ixigua.com',       /* 搜索页 500，且强制下载 App */
    'douguo.com',
    'haodou.com',
  ];

  function imgBlocked(url) {
    const m = String(url || '').match(/^https?:\/\/([^/?#]+)/i);
    if (!m) return true;
    const host = m[1].toLowerCase();
    return IMG_BLOCKED_HOSTS.some(function (b) {
      return host === b || host === 'www.' + b || host.endsWith('.' + b);
    });
  }

  function safeImage(url) {
    const u = String(url || '').trim();
    if (!u) return '';

    /* 本地选的照片：是我们自己在浏览器里用 canvas 压出来的 JPEG。
       只放行 data:image/jpeg|png|webp —— data: 家族里还有
       data:text/html 这种能执行脚本的，一个都不能混进来。 */
    if (/^data:image\/(jpeg|png|webp|gif);base64,[a-z0-9+/=]+$/i.test(u)) return u;

    if (!/^https?:\/\/[^\s]+$/i.test(u)) return '';
    if (imgBlocked(u)) return '';
    return u;
  }

  /* 下厨的人贴图时用的输入口：可留空、可之后补，所以不给任何"必填"的暗示 */
  function imageHtml(d, opts) {
    const o = opts || {};
    const src = safeImage(d && (d.image || d.imageUrl));
    if (src) {
      return '<figure class="dish-photo">' +
        '<img src="' + esc(src) + '" alt="' + esc((d && d.name) || '这道菜') + '" ' +
        'loading="lazy" referrerpolicy="no-referrer" ' +
        'onerror="this.closest(\'.dish-photo\').classList.add(\'is-broken\')">' +
        (o.caption ? '<figcaption>' + esc(o.caption) + '</figcaption>' : '') +
        '</figure>';
    }

    /* 退一步：他挑过教程，就用那份教程的来源标一张卡 */
    const tut = pickedTutorial(d);
    if (tut) {
      return '<div class="dish-photo dish-photo-tut">' +
        '<span class="ph-site">' + esc(tut.site) + '</span>' +
        '<span class="ph-note">这道菜的做法参考 · ' + esc(tut.kind || '教程') + '</span>' +
        '</div>';
    }
    return '';
  }

  /* "他挑的是哪一份教程"。存在 d.tutorialPick 里，值是站点名。
     没有就返回空，绝不乱猜 —— 猜错了显示的是别人的菜。 */
  function pickedTutorial(d) {
    const list = (d && d.tutorials) || [];
    const pick = (d && (d.tutorialPick || d.pickedTutorial)) || '';
    if (!pick || !list.length) return null;
    return list.filter(function (t) { return t.site === pick; })[0] || null;
  }

  /* 菜品特性：热量 / 营养 / 注意事项。

     这三项是模型写的，不是从权威数据库查的，所以展示上必须诚实：
     - 热量明确写"约"，不装精确。
     - 底部常驻一句来源说明，提醒别把它当营养处方。
     宁可看着朴素，也不能让一个估算数字看起来像检测报告。 */
  function factsHtml(d) {
    const cal = (d && d.calories) || '';
    const nut = (d && d.nutrition) || '';
    const cau = (d && d.cautions) || '';
    if (!cal && !nut && !cau) return '';

    let h = '<div class="facts">';
    h += '<div class="facts-head">这道菜大概什么样</div>';

    if (cal) {
      h += '<div class="fact-row"><span class="fact-k">热量</span>' +
           '<span class="fact-v">' + esc(cal) + '</span></div>';
    }
    if (nut) {
      h += '<div class="fact-row"><span class="fact-k">营养</span>' +
           '<span class="fact-v">' + esc(nut) + '</span></div>';
    }
    if (cau) {
      h += '<div class="fact-row is-warn"><span class="fact-k">注意</span>' +
           '<span class="fact-v">' + esc(cau) + '</span></div>';
    }

    h += '<div class="facts-note">以上由 AI 估算，仅供参考；' +
         '有具体饮食限制请以医生或注册营养师的意见为准。</div>';
    h += '</div>';
    return h;
  }

  function errText(err) {
    if (!err) return '未知错误';
    const code = err.code || (err.error && err.error.code);
    const msg = err.message || (err.error && err.error.message) || String(err);
    if (code === 'P0002') return '没找到这份菜单，请确认菜单码是否正确。';
    if (code === 'P0001') return '提交内容不完整，请至少选一道菜。';
    if (code === '42501') return '服务端拒绝了这次操作，请刷新页面重试。';
    if (code === '42P01') return '数据表不存在，请联系维护者。';
    if (code === '23505') return '记录已存在，请刷新后再试。';
    if (/Failed to fetch|NetworkError|network/i.test(msg)) return '网络连接失败，请检查网络后重试。';
    if (code) {
      if (/^quota_/.test(code)) return 'AI 调用额度已用完或触发限流，稍后再试。';
      if (/^auth_/.test(code)) return '这个域名没有调用 AI 的权限（来源校验不通过）。';
      if (/^request_/.test(code)) return '请求参数不被模型接受，换一种说法再试。';
      if (/^gateway_|^model_/.test(code)) return 'AI 服务暂时不可用，请稍后重试。';
      if (/^internal_/.test(code)) return 'AI 服务内部错误，请稍后重试。';
    }
    return msg;
  }

  /* ---------- 下厨的人提供的外卖 / 店里选项 ----------

     有些晚上就是不想开火。下厨的人清楚附近有什么、哪家能送，
     与其让点菜的人在"菜单外"里自己猜，不如他直接摆几个选项出来。

     两个端渲染的是同一份数据，所以样式和结构放在这里共用 ——
     免得一边改了、另一边忘了跟着改，两边看到的不是一回事。

     opts.pickable = true 时每行前面是可勾的复选框（点菜端用）；
     否则是只读展示。 */
  function takeoutHtml(list, opts) {
    const o = opts || {};
    const arr = (Array.isArray(list) ? list : []).filter(function (t) {
      return t && t.selected !== false && (t.shop || t.item);
    });
    if (!arr.length) return '';

    let h = '<div class="takeout-box">';
    h += '<div class="takeout-box-head">' + esc(o.head || '这顿也可以点外卖 / 出去吃') + '</div>';
    if (o.sub) h += '<p class="takeout-box-sub">' + esc(o.sub) + '</p>';

    arr.forEach(function (t, i) {
      const id = String(t.id || ('tk' + i));
      h += '<label class="takeout-line">';
      if (o.pickable) {
        h += '<input type="checkbox" data-field="takeoutPick" data-key="' + esc(id) + '"' +
             (o.picked && o.picked[id] ? ' checked' : '') + '>';
      } else {
        h += '<span class="takeout-dot" aria-hidden="true"></span>';
      }
      h += '<span class="takeout-line-main">';
      h += '<span class="takeout-line-name">' + esc(t.item || t.shop || '') + '</span>';
      if (t.item && t.shop) h += '<span class="takeout-line-shop">' + esc(t.shop) + '</span>';
      if (t.where) h += '<span class="takeout-line-where">' + esc(t.where) + '</span>';
      if (t.price) h += '<span class="takeout-line-price">' + esc(t.price) + '</span>';
      if (t.note) h += '<span class="takeout-line-note">' + esc(t.note) + '</span>';
      h += '</span>';
      h += '</label>';
    });

    h += '</div>';
    return h;
  }

  window.KF.util = {
    esc: esc,
    uid: uid,
    randToken: randToken,
    store: store,
    toast: toast,
    openModal: openModal,
    closeModal: closeModal,
    starsHtml: starsHtml,
    bindStars: bindStars,
    starLabels: STAR_LABELS,
    fmtTime: fmtTime,
    debounce: debounce,
    delegate: delegate,
    copyText: copyText,
    manualCopy: manualCopy,
    errText: errText,
    tutorialHtml: tutorialHtml,
    imageHtml: imageHtml,
    safeImage: safeImage,
    pickedTutorial: pickedTutorial,
    factsHtml: factsHtml,
    takeoutHtml: takeoutHtml,
  };
})();
