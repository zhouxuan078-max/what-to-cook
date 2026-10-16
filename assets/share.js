/* ==========================================================================
   分享数据层：把一份菜单 / 一份点单装进链接或二维码里

   为什么要这一层：这个站有两个角色（下厨的、点菜的），而两个人用的是两台
   不同的手机。以前中间靠一台云端服务器转发 —— 于是网站一旦被放到服务器
   不认的域名上，转发就断了，点菜端整片报错。

   现在改成"数据跟着链接走"：下厨的人把整份菜单压进网址里（`#` 后面的部分
   浏览器不会发给服务器），生成二维码；点菜的人扫码打开，浏览器在本地把
   菜单解出来。反过来点单也一样。**全程不需要任何服务器。**

   两条硬约束：
   1) 载荷只能由 base64url 的字符组成（A-Za-z0-9-_），这样放进网址不用转义、
      过微信也不会被吃掉。所以前缀用 `~`（它不在 base64url 里，不会撞车）。
   2) 二维码不能太密。模块数一多，手机屏上就要怼得很近才扫得出，
      所以超过阈值宁可退回"复制链接"，也不硬塞一个扫不动的码。
   ========================================================================== */
window.KF = window.KF || {};

(function () {
  'use strict';

  /* 载荷 = `~` + 一位编码方式 + base64url 正文
     0 = JSON 原样，1 = deflate 压缩过 */
  const PLAIN = '~0';
  const DEFLATED = '~1';

  /* 二维码密度上限：模块数超过这个值就太密了（≈ 版本 31）。
     微信扫码在手机屏上对这个密度还比较从容，再往上就要靠得很近。 */
  const QR_MAX_MODULES = 137;

  /* 载荷里可能夹着中文、引号、换行，所以要先转成字节再 base64，
     不能直接 btoa —— 它对非拉丁字符会直接抛错。 */
  function bytesToB64u(bytes) {
    let bin = '';
    /* 一次 apply 太多参数会把调用栈撑爆，分块处理 */
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function b64uToBytes(str) {
    let s = String(str || '').replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i) & 0xff;
    return out;
  }

  /* deflate-raw 是浏览器原生能力（Chrome 103+ / Safari 16.4+ / Firefox 113+）。
     老浏览器没有，这时不压缩也能用 —— 只是链接长一些，不是错误。 */
  function canZip() {
    return typeof window.CompressionStream === 'function' &&
           typeof window.DecompressionStream === 'function';
  }

  async function zipBytes(bytes) {
    const cs = new window.CompressionStream('deflate-raw');
    /* 先把读取端挂上再写：数据虽然不大，但反过来的顺序在某些浏览器上会卡住 */
    const done = new Response(cs.readable).arrayBuffer();
    const w = cs.writable.getWriter();
    await w.write(bytes);
    await w.close();
    return new Uint8Array(await done);
  }

  async function unzipBytes(bytes) {
    const ds = new window.DecompressionStream('deflate-raw');
    const done = new Response(ds.readable).arrayBuffer();
    const w = ds.writable.getWriter();
    await w.write(bytes);
    await w.close();
    return new Uint8Array(await done);
  }

  /* 编码。压不小就不压 —— 有些短载荷（比如点单）压缩后的头和它差不多大，
     压了反而更长。 */
  async function pack(obj) {
    const raw = new TextEncoder().encode(JSON.stringify(obj));
    if (canZip()) {
      try {
        const zipped = await zipBytes(raw);
        if (zipped.length < raw.length) return DEFLATED + bytesToB64u(zipped);
      } catch (e) { /* 压缩失败不影响可用性，下面走原样 */ }
    }
    return PLAIN + bytesToB64u(raw);
  }

  async function unpack(payload) {
    const s = String(payload == null ? '' : payload).trim();
    if (s.length < 3 || s.charAt(0) !== '~') {
      throw new Error('这段内容不是本站生成的分享码。');
    }
    const kind = s.charAt(1);
    let bytes;
    try {
      bytes = b64uToBytes(s.slice(2));
    } catch (e) {
      throw new Error('这段分享码缺了一截（聊天软件有时会把长内容截断），请让对方重发一次。');
    }
    if (kind === '1') {
      if (!canZip()) {
        throw new Error('这个浏览器太旧，解不开压缩过的分享码。请用手机自带浏览器或 Chrome / 微信打开。');
      }
      try {
        bytes = await unzipBytes(bytes);
      } catch (e) {
        throw new Error('这段分享码不完整，解不开。请让对方重发一次。');
      }
    } else if (kind !== '0') {
      throw new Error('分享码的格式不认识，可能不是这个站生成的。');
    }
    try {
      return JSON.parse(new TextDecoder().decode(bytes));
    } catch (e) {
      throw new Error('分享码的内容不完整，请让对方重发一次。');
    }
  }

  /* 载荷动辄上千字符，直接拿它当 localStorage 的键既难看又占地方。
     这里只取一个短指纹，用来认"是哪一份菜单 / 哪一条点单"。
     不是为了防碰撞，够用就行。 */
  function sig(str) {
    const s = String(str || '');
    let a = 0x811c9dc5, b = 0x9e3779b9;
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      a = Math.imul(a ^ c, 0x01000193) >>> 0;
      b = Math.imul(b ^ (c + i), 0x85ebca6b) >>> 0;
    }
    return (a.toString(36) + b.toString(36)).slice(0, 12);
  }

  /* 二维码里必须是完整网址，对方扫完要能直接打开。
     不带 ?v= 这类查询串 —— 那是本机版本自检留下的，进码里只会让码变密。 */
  function baseUrl() {
    if (/^https?:$/i.test(location.protocol)) {
      return location.origin + location.pathname;
    }
    /* 本地双击打开（file://）时没有 origin，退回用当前地址 */
    return String(location.href || '').split('#')[0].split('?')[0];
  }

  function menuLink(payload) { return baseUrl() + '#/m/' + payload; }
  function orderLink(payload) { return baseUrl() + '#/o/' + payload; }

  /* 家人在微信里发回来的可能是一整条链接、也可能前后还带着一句话，
     甚至是从聊天记录里连"【吃什么】…"一起复制下来的。
     所以不要求对方只发链接 —— 直接从整段文字里把载荷抠出来。 */
  const PAYLOAD_RE = /~[01][A-Za-z0-9_-]{16,}/;

  function extract(text) {
    const m = String(text == null ? '' : text).match(PAYLOAD_RE);
    return m ? m[0] : '';
  }

  /* 用户在输入框里粘进来的东西可能是三种：一条完整网址、一整段带话的消息、
     或者干脆就是旧的 6 位菜单码。这里统一取出"该拿去路由的那个值"。

     注意绝不能对它做 toUpperCase —— 载荷里的大小写是有意义的，
     转一次大小写就把整份菜单毁了。只有旧的短码才规整成大写。 */
  function codeFrom(text) {
    const t = String(text == null ? '' : text).trim();
    if (!t) return '';
    const p = extract(t);
    if (p) return p;
    const m = t.match(/#\/m\/([^\s&#?]+)/);
    const tail = m ? m[1] : t;
    if (!tail.length) return '';
    return tail.length <= 12 ? tail.toUpperCase() : tail;
  }

  /* ---------- 二维码 ---------- */

  function buildQr(text) {
    if (typeof window.qrcode !== 'function') return null;
    let q;
    try {
      /* 版本传 0＝让库自己挑最小的那一个；纠错等级用 L，容量最大。
         菜单是家用场景，不怕轻微污损，容量比抗损更重要。 */
      q = window.qrcode(0, 'L');
      q.addData(String(text), 'Byte');   /* 内容全是 ASCII 的 base64url */
      q.make();
    } catch (e) {
      return null;   /* 内容超过二维码容量上限 */
    }
    return q;
  }

  /* 能不能生成一个"扫得动"的二维码 */
  function qrFits(text) {
    const q = buildQr(text);
    if (!q) return false;
    return q.getModuleCount() <= QR_MAX_MODULES;
  }

  /* 画成 PNG。不用 SVG：一个版本 30 的码有几千个黑块，
     拼成 path 字符串会有上百 KB，画到 canvas 只要几 KB。 */
  function qrDataUrl(text, boxPx) {
    const q = buildQr(text);
    if (!q) return '';
    const n = q.getModuleCount();
    const quiet = 4;                 /* 静区：四周留白，少了扫不出来 */
    const total = n + quiet * 2;
    const px = Math.max(2, Math.floor((boxPx || 320) / total));
    const dim = px * total;

    const cv = document.createElement('canvas');
    cv.width = dim;
    cv.height = dim;
    const ctx = cv.getContext('2d');
    /* 必须是黑白 —— 深色主题下用主题色画会扫不出来 */
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, dim, dim);
    ctx.fillStyle = '#000000';
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        if (q.isDark(r, c)) ctx.fillRect((c + quiet) * px, (r + quiet) * px, px, px);
      }
    }
    return cv.toDataURL('image/png');
  }

  window.KF.share = {
    pack: pack,
    unpack: unpack,
    sig: sig,
    extract: extract,
    codeFrom: codeFrom,
    baseUrl: baseUrl,
    menuLink: menuLink,
    orderLink: orderLink,
    qrFits: qrFits,
    qrDataUrl: qrDataUrl,
  };
})();
