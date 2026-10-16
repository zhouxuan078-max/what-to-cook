/* ==========================================================================
   AI 层（**不联网，不发任何请求**）

   这个文件里没有任何一处会去调大模型 —— 站里没有内置模型了。
   它现在只干四件事：

   1) 拼提示词（ownPrompt → SYS_RULES + buildUserPrompt）
      —— 拼好给用户复制走，到他手机上的 AI 应用里跑；
   2) 把粘回来的那段文本解析成菜（ingestExternal）
      —— 容忍 markdown 围栏、开场白、被截断；
   3) "家里有没有"由本地清单做确定性判定，不交给模型判断（normalizeDish）；
   4) 教程链接一律用真实站点的搜索入口，不让模型编 URL（tutorials / safeUrl）。

   连模型的代码（generate / generateSteps）、模型白名单与档位表、
   以及只给站内调用用的那两段 system 提示词，都已经删掉了。
   ========================================================================== */
window.KF = window.KF || {};

(function () {
  'use strict';

  /* 厨房基础调料：默认视为已有，用户可关掉 */
  const BASE_PANTRY = [
    '盐', '食用油', '白糖', '生抽', '老抽', '料酒', '淀粉',
    '白胡椒粉', '葱', '姜', '蒜', '醋', '香油', '蚝油', '鸡精',
  ];

  const MATERIAL_TYPES = ['食材', '香料', '调味', '主食', '其他'];

  /* ------------------------------------------------------------------
     提示词
     ------------------------------------------------------------------ */

  /* 规则本体。**这一段会被用户原样复制走**（「用你自己的 AI」粘贴式要用），
     所以里面只能写"对模型说的话"，不能写我们自己的开发笔记 ——
     用户把提示词贴进豆包、元宝，转头就会看见"实测思考时长"这种句子。
     想加开发笔记，就加在这一段外面，别加进数组里。 */
  const SYS_RULES = [
    '你是一位务实的中餐家常菜厨师助手，擅长用厨房里现有的材料拼出一顿饭。',
    '',
    '输出规则（必须遵守）：',
    '1. 只输出一个 JSON 对象。不要输出解释、问候、前后缀说明，也不要使用 markdown 代码块标记。',
    '2. 不要推荐用户明确表示不吃或忌口的材料。',
    '3. materials 必须列出做这道菜真正需要的全部材料，包含主辅食材、香料和调味料；不要因为"太普通"就省略香料或调味。',
    '4. 判断某样材料家里有没有时，只能依据用户给出的清单，不要擅自假设用户有清单之外的材料。',
    '5. 本轮不要输出烹饪步骤，步骤后面会单独问。',
    '6. reason 只写一句话，30 字以内，说明为什么用现有材料能做出它、为什么适合这一顿。',
    '7. 全部用简体中文。',
    '',
    '营养与热量信息的规矩（很重要，务必遵守）：',
    '8. calories 要写成带单位重量的形式，也就是"每 100 克多少千卡"，因为光给一个整数没人知道那是一盘还是一口。',
    '   写法照这个来：「每 100 克约 180 千卡」。',
    '   再加一句整盘的量作为参考，比如「这一盘约 450 克，合计约 810 千卡」；份量拿不准就只说每 100 克的数。',
    '9. 数字一律用"约"，可以给范围（每 100 克约 150-200 千卡）。不要写成"187 千卡"这种看起来像实验室测出来的精度。',
    '10. cautions 尽量写。只要这道菜有值得提醒的地方就写出来，不要因为"可能有人不爱听"就留空。',
    '    常见的几类：',
    '    - 人群：痛风、高血脂、高血压、糖尿病、胃病、孕妇、小孩、老人该少吃的，写出来；',
    '    - 食材本身：内脏的胆固醇、腌制品和豆瓣酱的钠、油炸和肥肉的油脂、动物皮的脂肪、生食的风险；',
    '    - 做法：油温过高、久煮、反复用油；',
    '    - 明确的成分提醒：含酒精、含花生等常见致敏物、含动物内脏。',
    '    每条一句话说清"谁、为什么要少"，比如「痛风人群应少食，虾的嘌呤偏高」。确实无话可说时才写空字符串。',
    '11. 绝对不要写"某某和某某同食会中毒/致癌/相克"这类没有可靠依据的说法。中国传统里的"食物相克"绝大多数已被现代营养学否定，不要复述。',
    '12. 不要引用任何自媒体、短视频、营销号、个人博客的说法。只写营养学教材和官方膳食指南里能站住的内容。',
    '13. 不要写任何"治疗""治愈""预防疾病""增强免疫力"之类的医疗功效声明。',
    '14. 写不准的地方就换个说法或留空，不要用"据说""网上说"来兜，也不要为了凑字数硬编。',
    '',
    '速度要求：',
    '15. 按用户给的食材直接列出家常菜，拿定主意就往下写，不要在脑子里反复比较、',
    '    自我检查、推翻重来。数量就是用户要的那个数，写完最后一道立刻闭合 JSON。',
  ].join('\n');

  /* 以前这里还有两段**只给站内调用**的提示词：SYS_PROMPT（＝SYS_RULES +
     一段开发笔记）和 SYS_STEPS（写做法的 system）。站内不再直接调模型，
     两段都没有调用方了，跟着 generate / generateSteps 一起删掉。

     注意 SYS_RULES 上面那段**不能动**：它是被用户复制走的那份提示词的本体
     （见 ownPrompt），读者是别人家的 AI，不是我们。 */

  /* ------------------------------------------------------------------
     第二部分：换换口味

     用户的要求是「相同条件下每次分析结果尽量不相同」。这件事不能靠
     temperature 一个人扛 —— 采样温度只影响措辞，模型在同一个 prompt 上
     给出的前几道菜高度稳定（都是番茄炒蛋那一档）。

     所以这里换一个思路：给这一轮**明确指定一个方向**，方向本身每轮都变。
     同一个冰箱、同一个时段，第一轮问「蒸 / 炖」，下一轮问「凉拌 / 快炒」，
     再下一轮问「面点 / 一锅出」。菜色自然会换一批，而不是换个说法。

     另外把上一轮已经给过的菜名传进去让它避开，这样连点两次不会看到
     一模一样的清单。 */
  const ANGLES = [
    { id: 'stirfry', label: '快炒小炒', hint: '急火快炒、下饭的小炒，比如各种肉片菜片配着炒' },
    { id: 'steam', label: '蒸和炖', hint: '上锅蒸的、小火炖的，省着站灶台的' },
    { id: 'soup', label: '汤和羹', hint: '一碗热汤或羹，配饭配面都行' },
    { id: 'cold', label: '凉拌凉菜', hint: '不用开大火、拌一拌就能上桌的' },
    { id: 'noodle', label: '面点主食', hint: '面条、饼、饺子、米饭类的一锅出' },
    { id: 'onepot', label: '一锅出', hint: '一口锅搞定、少洗碗的焖菜和煲仔' },
    { id: 'oven', label: '烤箱空气炸锅', hint: '烤的、空气炸的，不用看火' },
    { id: 'sweet', label: '甜口和点心', hint: '带点甜的菜或饭后小点心' },
    { id: 'light', label: '清淡少油', hint: '少油少盐、吃着不腻的' },
    { id: 'hearty', label: '解馋硬菜', hint: '分量足、解馋的大菜，适合犒劳自己' },
  ];

  /* 抽一个跟上一轮不一样的方向。传 lastId 就能保证不连续重复。 */
  function pickAngle(lastId, rand) {
    const r = typeof rand === 'function' ? rand : Math.random;
    const pool = ANGLES.filter(function (a) { return a.id !== lastId; });
    const from = pool.length ? pool : ANGLES;
    return from[Math.floor(r() * from.length) % from.length];
  }

  function angleLabel(id) {
    for (let i = 0; i < ANGLES.length; i++) if (ANGLES[i].id === id) return ANGLES[i].label;
    return '';
  }

  function angleHint(id) {
    for (let i = 0; i < ANGLES.length; i++) if (ANGLES[i].id === id) return ANGLES[i].hint;
    return '';
  }

  /* 每一轮的"变动因子"。除了方向，再给一点时令和口味上的扰动，
     免得方向抽到同一个时结果还是老样子。 */
  const TWISTS = [
    '这一轮尽量换些平常不太想得起来的做法',
    '这一轮多用一点手边常见的调料换个口',
    '这一轮可以有一两道带点新意的',
    '这一轮优先挑好做、不容易翻车的',
    '这一轮照顾一下想吃点热乎的心理',
    '这一轮可以安排一两道能提前做好的',
  ];

  function pickTwist(rand) {
    const r = typeof rand === 'function' ? rand : Math.random;
    return TWISTS[Math.floor(r() * TWISTS.length) % TWISTS.length];
  }

  function normName(s) {
    return String(s == null ? '' : s)
      .replace(/[\s\u3000]+/g, '')
      .replace(/[（）()【】\[\]、,，。.·\-—_/／"'"']/g, '')
      .toLowerCase();
  }

  /* 本地判定"有没有"：完全相等，或一方包含另一方且较短者不少于 2 字 */
  function hasMaterial(pantryNorms, name) {
    const n = normName(name);
    if (!n) return false;
    for (let i = 0; i < pantryNorms.length; i++) {
      const p = pantryNorms[i];
      if (!p) continue;
      if (p === n) return true;
      if (p.length >= 2 && n.indexOf(p) >= 0) return true;
      if (n.length >= 2 && p.indexOf(n) >= 0) return true;
    }
    return false;
  }

  /* 真实站点搜索入口 —— 全部实测可打开，且落地页确为菜谱内容。

     ⚠️ 这份清单是「白名单」，不是「尽量多收几个」。曾经收录过的站点已经出事，
        留着就是拿用户的信任和安全做赌注：

     - 香哈菜谱（xiangha.com）：域名被赌博团伙接手，点进去是赌博页。
     - 心食谱（xinshipu.com）：首页被挂马，302 到 /hl/index68.html ——
       标题「为人民服务」，正文是「首存送 100 元」「HTH 注册」。
     - 美食杰（meishij.net）：**同一路径在电脑和手机上拿到两种完全不同的响应** ——
       电脑 UA 返回 138 字节的「404 Not Found」，手机 UA 返回 2467 字节的
       JS 空壳（标题正常、正文什么都没有），真正的内容是它客户端再拉第三方的。
       用户在手机端点进去看到赌博页，就是这么来的。已移出白名单。
     - 西瓜视频（ixigua.com）：search 302 到 m.ixigua.com 后返回 HTTP 500，
       且页面要求下载 App 才能看。已移出白名单。
     - 豆果美食、好豆网的搜索路径均已失效（404），不再收录。
     - 知乎搜索返回 403（反爬），也不收录。

     教训一：这类「菜谱站」域名价值低、易被博彩接手，收录后必须定期回访。
     教训二：**必须用手机 UA 和电脑 UA 各验一次**。只用电脑 UA 验，
            美食杰是"正常 200"；只看首页不看搜索页，也发现不了问题。
     新增任何站点前，务必两种 UA 都实测落地页正文。 */
  const TUTORIAL_SITES = [
    { site: '下厨房', kind: '图文', q: function (n) { return n; },
      url: function (q) { return 'https://www.xiachufang.com/search/?keyword=' + encodeURIComponent(q); } },
    { site: '抖音', kind: '视频', q: function (n) { return n + ' 做法'; },
      url: function (q) { return 'https://www.douyin.com/search/' + encodeURIComponent(q); } },
    { site: '哔哩哔哩', kind: '视频', q: function (n) { return n + ' 做法'; },
      url: function (q) { return 'https://search.bilibili.com/all?keyword=' + encodeURIComponent(q); } },
    { site: '腾讯视频', kind: '视频', q: function (n) { return n + ' 做法'; },
      url: function (q) { return 'https://v.qq.com/x/search/?q=' + encodeURIComponent(q); } },
    { site: '百度', kind: '搜索', q: function (n) { return n + ' 做法'; },
      url: function (q) { return 'https://www.baidu.com/s?wd=' + encodeURIComponent(q); } },
  ];

  /* 兜底：万一将来某条被从清单里移除，而用户菜单里还存着旧的 tutorials
     （存在云端，不会自己更新），点下去就会把已经出事的站点打开。
     这里按域名做一次拦截，命中就换成一次安全搜索。 */
  const BLOCKED_HOSTS = [
    'xiangha.com',      /* 已被赌博站接手 */
    'xinshipu.com',     /* 首页被挂马，跳转赌博页 */
    'meishij.net',      /* 手机端跳到赌博页（电脑端 404，双面站点） */
    'meishij.com',
    'ixigua.com',       /* 搜索页 500，且强制下载 App */
    'douguo.com',       /* 搜索路径失效 */
    'haodou.com',       /* 搜索路径失效 */
  ];

  function isBlocked(url) {
    const m = String(url || '').match(/^https?:\/\/([^/?#]+)/i);
    if (!m) return true;                       // 不是 http(s) 链接，一律不放行
    const host = m[1].toLowerCase();
    return BLOCKED_HOSTS.some(function (b) {
      return host === b || host === 'www.' + b || host.endsWith('.' + b);
    });
  }

  function safeUrl(dishName, url) {
    if (!isBlocked(url)) return url;
    return 'https://www.baidu.com/s?wd=' + encodeURIComponent(dishName + ' 做法');
  }

  function tutorials(name, query) {
    const base = (query && String(query).trim()) || name;
    return TUTORIAL_SITES.map(function (t) {
      return {
        site: t.site,
        kind: t.kind,
        label: t.kind + '菜谱',
        url: t.url(t.q(base)),
      };
    });
  }

  /* ------------------------------------------------------------------
     用户自己指定去哪找教程

     白名单永远是有限的，而"我想去 X 找"是用户自己的判断 ——
     他可能习惯某个站、某个博主的主页、或者自己存的一份文档。
     所以这里允许他给出任意一个 http(s) 地址或域名。

     但放开手填就必须自己把住关：
     1. 只认 http/https —— javascript:/data: 这类不能进。（isBlocked 已做）
     2. 明显的私网/本机地址挡掉。这条是为了避免把用户自己家的
        http://192.168.1.1 之类写进菜单再分享出去 —— 别人点开是打不开的，
        而且等于把他的内网结构暴露给别人。
     3. 只填域名时，自动补成一个搜索地址。不同站的搜索路径各不相同，
        猜错就是 404，所以这里只对几个已知站点拼搜索路径，
        其余一律用百度站内搜索 —— 宁可多一跳，也不给一个死链。 */
  const KNOWN_SEARCH = [
    { host: 'xiachufang.com', url: function (q) { return 'https://www.xiachufang.com/search/?keyword=' + encodeURIComponent(q); } },
    { host: 'douyin.com', url: function (q) { return 'https://www.douyin.com/search/' + encodeURIComponent(q); } },
    { host: 'bilibili.com', url: function (q) { return 'https://search.bilibili.com/all?keyword=' + encodeURIComponent(q); } },
    { host: 'v.qq.com', url: function (q) { return 'https://v.qq.com/x/search/?q=' + encodeURIComponent(q); } },
    { host: 'xiaohongshu.com', url: function (q) { return 'https://www.xiaohongshu.com/search_result?keyword=' + encodeURIComponent(q); } },
  ];

  /* 中文站名 → 域名。用户填「下厨房」的时候指的是那个站，不是一串拼音域名。
     不查这张表的话，'下厨房' 会被当成主机名送去 punycode，
     变成 site:xn--ghqs0lf8n 这种谁也看不懂、搜不到东西的东西。 */
  const NAME_ALIAS = [
    { name: '下厨房', host: 'xiachufang.com' },
    { name: '抖音', host: 'douyin.com' },
    { name: '哔哩哔哩', host: 'bilibili.com' },
    { name: 'B站', host: 'bilibili.com' },
    { name: 'BiliBili', host: 'bilibili.com' },
    { name: '小红书', host: 'xiaohongshu.com' },
    { name: '腾讯视频', host: 'v.qq.com' },
    { name: '百度', host: 'baidu.com' },
    { name: '知乎', host: 'zhihu.com' },
    { name: '微博', host: 'weibo.com' },
  ];

  function lookupAlias(s) {
    const t = String(s || '').trim().toLowerCase();
    for (let i = 0; i < NAME_ALIAS.length; i++) {
      if (NAME_ALIAS[i].name.toLowerCase() === t) return NAME_ALIAS[i].host;
    }
    return '';
  }

  /* 是不是一个像域名的东西：有英文/数字的点分结构，或者就是个英文词。
     中文（非 ASCII）一律不算域名 —— 那多半是站名。 */
  function looksLikeHost(s) {
    if (!/^[\x00-\x7F]+$/.test(s)) return false;         /* 含非 ASCII，不是域名 */
    if (/\s/.test(s)) return false;
    return /^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/i.test(s) || /^[a-z0-9-]+$/i.test(s);
  }

  function isPrivateHost(host) {
    const h = String(host || '').toLowerCase();
    if (!h) return true;
    if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local')) return true;
    /* IPv4 私网段 + 环回 */
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) {
      const p = h.split('.').map(Number);
      if (p[0] === 10 || p[0] === 127 || p[0] === 0) return true;
      if (p[0] === 192 && p[1] === 168) return true;
      if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true;
      if (p[0] === 169 && p[1] === 254) return true;
      return false;
    }
    if (h === '::1' || h.indexOf(':') >= 0) return true;   /* IPv6 一律不收，够用了 */
    return false;
  }

  /* 把用户输入变成一条教程条目。返回 null 表示这个输入不能用。 */
  function customTutorial(raw, dishName) {
    let s = String(raw || '').trim();
    if (!s) return null;
    const q = (dishName || '').trim();

    /* 情况一：他填的是个站名（「下厨房」「小红书」）。
       先查别名表；查不到就不硬猜域名 —— 猜出来的是拼音域名，
       打不开还让人以为是他的问题。这种情况给一次百度搜索，稳稳能用。 */
    if (!/^[a-z][a-z0-9+.-]*:/i.test(s) && !looksLikeHost(s)) {
      /* 纯符号/纯标点不可能是站名，也不是人能读的搜索词，直接退掉。
         不这样挡的话 "!!!###" 会被拼成一个毫无意义的百度搜索存进菜单。 */
      if (!/[\u4e00-\u9fa5a-z0-9]/i.test(s)) return null;
      const hit = lookupAlias(s);
      if (hit) {
        for (let i = 0; i < KNOWN_SEARCH.length; i++) {
          if (KNOWN_SEARCH[i].host === hit) {
            return { site: '我指定的', kind: '自定', label: '自定来源', url: KNOWN_SEARCH[i].url(q) };
          }
        }
      }
      return {
        site: '我指定的', kind: '自定', label: '自定来源',
        url: 'https://www.baidu.com/s?wd=' + encodeURIComponent(s + ' ' + q),
      };
    }

    /* 情况二：域名或完整网址 —— 补上协议再解析 */
    if (!/^[a-z][a-z0-9+.-]*:/i.test(s)) s = 'https://' + s.replace(/^\/+/, '');

    let u;
    try { u = new URL(s); } catch (e) { return null; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    if (isPrivateHost(u.hostname)) return null;
    if (isBlocked(u.href)) return null;
    /* 主机名带非 ASCII 的，解析出来是 punycode，不是他想要的东西 */
    if (u.hostname.indexOf('xn--') === 0) return null;

    /* 只给了域名（没有具体路径）→ 拼一个搜索地址，别给一个首页了事 */
    const bare = (u.pathname === '/' || u.pathname === '') && !u.search;
    if (bare) {
      for (let i = 0; i < KNOWN_SEARCH.length; i++) {
        const k = KNOWN_SEARCH[i];
        if (u.hostname === k.host || u.hostname === 'www.' + k.host || u.hostname.endsWith('.' + k.host)) {
          return { site: '我指定的', kind: '自定', label: '自定来源', url: k.url(q) };
        }
      }
      return {
        site: '我指定的', kind: '自定', label: '自定来源',
        url: 'https://www.baidu.com/s?wd=' + encodeURIComponent('site:' + u.hostname + ' ' + q),
      };
    }

    /* 给了具体页面 → 原样用 */
    return { site: '我指定的', kind: '自定', label: '自定来源', url: u.href };
  }

  /* ------------------------------------------------------------------
     用餐时段

     两个原则：
     1. 用户明确选的时段永远优先。
     2. 用户没选，就按"现在几点"给一个默认值 —— 但只是推荐排序的偏好，
        不是限制。半夜想吃红烧肉的人不该被应用拦住。
     ------------------------------------------------------------------ */

  const MEALS = [
    { id: 'breakfast', label: '早餐', range: [5, 10] },
    { id: 'lunch', label: '午餐', range: [10, 15] },
    { id: 'dinner', label: '晚餐', range: [15, 21] },
    { id: 'latenight', label: '夜宵', range: [21, 29] },  /* 21:00 到次日 05:00 */
  ];

  /* 按当前钟点猜一个时段。传 date 是为了可测试。 */
  function guessMeal(date) {
    const d = date || new Date();
    let h = d.getHours();
    if (h < 5) h += 24;                       /* 凌晨归到夜宵那一段 */
    for (let i = 0; i < MEALS.length; i++) {
      if (h >= MEALS[i].range[0] && h < MEALS[i].range[1]) return MEALS[i].id;
    }
    return 'dinner';
  }

  function mealLabel(id) {
    if (!id) return '';
    for (let i = 0; i < MEALS.length; i++) if (MEALS[i].id === id) return MEALS[i].label;
    return String(id);                        /* 用户自定的名字，原样用 */
  }

  /* 时段 → 给模型的偏好说明。这里只讲"什么更适合这个点吃"，
     不写成硬性约束 —— 用户要的菜永远可以盖过它。 */
  const MEAL_HINT = {
    breakfast: '早餐。优先清爽、好消化、能在 20 分钟内做好的，比如粥、面、蛋类、包子馒头配菜。避免过于油腻厚重的大菜。',
    lunch: '午餐。可以吃得正式一些，荤素搭配、有主食，扛得住一下午。',
    dinner: '晚餐。家常正餐，荤素搭配即可。可以比午餐清淡一点，但不必刻意减量。',
    latenight: '夜宵。优先量少、好消化、不油腻的，比如汤面、粥、小炒、蒸蛋。避免重油重辣和过量。',
  };

  /* 把当前时间信息整理成一小段，交给模型当背景参考。
     之所以要写明年月日：时令菜、节气、"这个季节该吃什么"都依赖它，
     模型自己不知道今天是几号。 */
  function timeContext(date) {
    const d = date || new Date();
    const pad = function (n) { return n < 10 ? '0' + n : String(n); };
    const y = d.getFullYear(), mo = d.getMonth() + 1, day = d.getDate();
    const hh = pad(d.getHours()), mi = pad(d.getMinutes());
    const week = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'][d.getDay()];
    const season = mo >= 3 && mo <= 5 ? '春' : mo >= 6 && mo <= 8 ? '夏'
                 : mo >= 9 && mo <= 11 ? '秋' : '冬';
    return {
      year: y, month: mo, day: day,
      clock: hh + ':' + mi,
      weekday: week,
      season: season,
      text: y + ' 年 ' + mo + ' 月 ' + day + ' 日（' + week + '）' + hh + ':' + mi +
            '，' + season + '季',
    };
  }

  function buildUserPrompt(ctx) {
    const lines = [];
    lines.push('【现在是什么时候】');
    lines.push(ctx.timeText || '（未知）');
    lines.push('');
    lines.push('【我现有的食材】');
    lines.push(ctx.ingredients.length ? ctx.ingredients.join('、') : '（暂时没填）');
    lines.push('');
    lines.push('【我现有的香料 / 调味料】');
    lines.push(ctx.spices.length ? ctx.spices.join('、') : '（没单独列，按下面的基础调料算）');
    lines.push('');
    lines.push('【厨房基础调料】');
    lines.push(ctx.useBasePantry
      ? '以下这些默认家里有：' + BASE_PANTRY.join('、')
      : '不作假设，上面清单之外的材料都算没有。');
    lines.push('');
    lines.push('【这顿饭的约束】');
    lines.push('- 吃的是哪一顿：' + (ctx.mealLabel || '未指定'));
    if (ctx.mealHint) lines.push('- 这一顿的偏好：' + ctx.mealHint);
    if (ctx.mealCustom) lines.push('- 用户自己补充的说明：' + ctx.mealCustom);
    lines.push('- 人数：' + (ctx.people || '未指定'));
    lines.push('- 忌口 / 不吃：' + (ctx.avoid || '无'));
    lines.push('- 选菜要求：' + (ctx.matchesAll
      ? '只能用我现有的材料，一道菜里不允许出现我没有的材料。'
      : '可以允许一道菜里最多有 ' + ctx.allowMissing + ' 种材料是我没有的，需要我去买。'));

    /* 第二部分：把这一轮"走哪个方向"写进去。
       mode 不是 explore 时这几行完全不出现 —— 第一部分必须每次一样。 */
    if (ctx.mode === 'explore') {
      lines.push('');
      lines.push('【这一轮特别的要求】');
      if (ctx.angleHint) lines.push('- 这次往「' + ctx.angleLabel + '」这个方向想：' + ctx.angleHint + '。');
      if (ctx.twist) lines.push('- ' + ctx.twist + '。');
      lines.push('- 同样是这几样材料，请在做法和搭配上多换几种花样，不要总是那几个最常见的答案。');
    }

    /* 要避开的菜名独立于 mode 之外写出。原来这几行只在 explore 里，
       结果"免费档先来一小批、再补一批"的第二次请求（mode 是 stable）
       完全不提第一批已经给出过什么 —— 补的那批会把第一批重写一遍。
       试跑一次就复现了：两批合起来只剩 4 道不重复的。 */
    if (ctx.avoidNames && ctx.avoidNames.length) {
      lines.push('');
      lines.push('【已经定下来的菜，不要再重复】');
      lines.push(ctx.avoidNames.slice(0, 20).join('、') + '。');
      lines.push('上面这些已经选进这顿饭了，请另外推荐不同的菜。');
    }

    lines.push('');
    lines.push('【请输出】');
    lines.push('推荐 ' + ctx.count + ' 道菜。只说菜名、材料和特性，不要写做法。');
    lines.push('把最贴合"这一顿"的排在前面。如果季节或时令有关系，优先用当季的食材。');
    lines.push('按 JSON 输出，结构严格如下：');
    lines.push('{');
    lines.push('  "dishes": [');
    lines.push('    {');
    lines.push('      "name": "菜名",');
    lines.push('      "cuisine": "菜系或风味，如 家常 / 川菜 / 粤菜",');
    lines.push('      "difficulty": "简单 或 中等 或 稍难",');
    lines.push('      "time_minutes": 25,');
    lines.push('      "servings": 2,');
    lines.push('      "reason": "一句话说明为什么推荐它，要结合我现有的食材和这一顿的时段",');
    lines.push('      "calories": "必须带单位重量的热量。照这个格式：「每 100 克约 180 千卡；这一盘约 450 克，合计约 810 千卡」。份量拿不准就只写「每 100 克约 XXX 千卡」。数字用约数或范围，不要精确到个位。",');
    lines.push('      "nutrition": "这道菜的主要营养特点，一到两句，如 蛋白质丰富、碳水和油脂偏高。",');
    lines.push('      "cautions": "这道菜值得提醒的地方，尽量写、不要留空。写清是谁为什么要少吃，比如「痛风人群应少食，虾的嘌呤偏高」「含豆瓣酱，钠偏高，高血压人群注意」。确实没有可提醒的才写空字符串。",');
    lines.push('      "materials": [');
    lines.push('        { "name": "材料名", "type": "食材 或 香料 或 调味 或 主食 或 其他", "amount": "用量，如 200克 / 2勺" }');
    lines.push('      ]');
    lines.push('    }');
    lines.push('  ]');
    lines.push('}');
    return lines.join('\n');
  }

  /* ------------------------------------------------------------------
    解析
     ------------------------------------------------------------------ */

  /* 从模型输出里稳健地取出 JSON：容忍前后废话和 ``` 包裹 */
  function extractJson(text) {
    if (!text) throw new Error('模型没有返回内容。');
    let s = String(text).trim();
    s = s.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
    const start = s.indexOf('{');
    const end = s.lastIndexOf('}');
    if (start < 0 || end <= start) throw new Error('模型返回的内容不是 JSON。');
    const body = s.slice(start, end + 1);
    try {
      return JSON.parse(body);
    } catch (e) {
      /* 常见瑕疵一：尾随逗号 */
      try {
        return JSON.parse(body.replace(/,\s*([\]}])/g, '$1'));
      } catch (e2) {
        /* 常见瑕疵二：中间某一段坏掉了（少个冒号、多个逗号、串到一半断了）。
           这种时候整串 JSON.parse 一定会失败，但**大部分菜是完好的**。
           实测快速版偶尔会这样崩一次，而这一崩就是用户白等十几秒、
           界面上什么都没有。所以退一步：把完整的那几道菜一个个抠出来。

           前面流式上屏用的 extractCompleteDishes 正好干的就是这件事 ——
           它按括号深度扫，字符串里的括号不算，坏的那一个跳过、好的照收。
           所以这里直接复用，不再写第二套。

           代价是只用得上"完整的"菜：断掉的那最后一道会丢。但比起
           "全丢、还报错"，丢掉末一道要好得多，而且用户根本察觉不到 ——
           流式上屏那一路早就把前几道显示出来了。 */
        const good = extractCompleteDishes(body);
        if (good.length) return { dishes: good };
        throw e;
      }
    }
  }

  /* 流式解析：把已经写完的菜对象一个个抠出来，这样能边生成边显示。
     按括号深度扫描，字符串里的括号不算。 */
  function extractCompleteDishes(raw) {
    const out = [];
    if (!raw) return out;
    const key = raw.indexOf('"dishes"');
    if (key < 0) return out;
    const lb = raw.indexOf('[', key);
    if (lb < 0) return out;

    let depth = 0;
    let start = -1;
    let inStr = false;
    let esc = false;

    for (let i = lb + 1; i < raw.length; i++) {
      const c = raw.charAt(i);
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') { inStr = true; continue; }
      if (c === '{') {
        if (depth === 0) start = i;
        depth++;
        continue;
      }
      if (c === '}') {
        depth--;
        if (depth === 0 && start >= 0) {
          try { out.push(JSON.parse(raw.slice(start, i + 1))); } catch (e) { /* 单项坏了就跳过 */ }
          start = -1;
        }
        continue;
      }
      if (c === ']' && depth === 0) break;
    }
    return out;
  }

  function str(v, max) {
    const s = String(v == null ? '' : v).trim();
    return max && s.length > max ? s.slice(0, max) : s;
  }
  function cleanArr(v, max) {
    return Array.isArray(v) ? v.slice(0, max) : [];
  }

  /* 用菜名派生的稳定 id：边生成边显示时不会因重绘换 id 而闪 */
  function dishId(name) {
    const n = normName(name) || 'dish';
    let h = 5381;
    for (let i = 0; i < n.length; i++) h = ((h * 33) ^ n.charCodeAt(i)) >>> 0;
    return 'ai-' + h.toString(36) + '-' + n.length.toString(36);
  }

  function buildPantryNorms(ctx) {
    const norms = [];
    (ctx.ingredients || []).concat(ctx.spices || []).forEach(function (x) {
      const n = normName(x);
      if (n && norms.indexOf(n) < 0) norms.push(n);
    });
    if (ctx.useBasePantry) {
      BASE_PANTRY.forEach(function (x) {
        const n = normName(x);
        if (n && norms.indexOf(n) < 0) norms.push(n);
      });
    }
    return norms;
  }

  /* 模型给的一道菜 → 界面用的对象。做法留空，等用户要看时再要。 */
  function normalizeDish(d, pantryNorms, allow) {
    const materials = cleanArr(d && d.materials, 30).map(function (m) {
      const nm = str(m && m.name, 40);
      let type = str(m && m.type, 6);
      if (MATERIAL_TYPES.indexOf(type) < 0) type = '食材';
      return { name: nm, type: type, amount: str(m && m.amount, 24), have: hasMaterial(pantryNorms, nm) };
    }).filter(function (m) { return !!m.name; });

    const name = str(d && d.name, 40);
    const missing = materials.filter(function (m) { return !m.have; });

    return {
      id: dishId(name),
      name: name,
      source: 'ai',
      cuisine: str(d && d.cuisine, 16),
      difficulty: str(d && d.difficulty, 8),
      timeMinutes: Number(d && d.time_minutes) > 0 ? Math.round(Number(d.time_minutes)) : null,
      servings: Number(d && d.servings) > 0 ? Math.round(Number(d && d.servings)) : null,
      reason: str(d && d.reason, 60),
      /* 特性信息。上限放得比较宽，原因是这几项现在都要求"说清楚"
         （热量要带每 100 克的数，注意事项要写清谁该少吃），
         卡太紧会把句子拦腰切断，只剩下「每 100 克约」这种半截话。
         这些文字最终会进云端、也会显示给点菜的人，所以还是要有个头。 */
      calories: str(d && d.calories, 120),
      nutrition: str(d && d.nutrition, 160),
      cautions: str(d && d.cautions, 200),
      materials: materials,
      steps: [],
      tips: '',
      tutorialQuery: name,
      tutorials: tutorials(name),
      missing: missing.map(function (m) { return m.name; }),
      missingCount: missing.length,
      allowed: missing.length <= allow,
      selected: false,
    };
  }

  /* ------------------------------------------------------------------
     用你自己的 AI（粘贴式）—— **站里唯一的 AI 用法**

     算力在用户自己手机上：那边多半已经装着豆包 / 元宝 / DeepSeek 这类应用，
     是现成的、不花任何人的钱。网页拿不到那些 App（它们没有 Web API，见下面），
     所以只能**人工中转**：这边生成提示词，用户复制过去跑，再把回复粘回来。

     ---- 为什么不做成"自动调用" ----
     试过的三条自动路都不通：手机系统助手（小艺/小爱/Siri）没有 Web API，
     Apple 的端侧模型只对原生 App 开放；浏览器端侧模型（Chrome 的 Prompt API /
     Gemini Nano）官方明确不支持 Android/iOS 上的 Chrome；WebLLM 手机实测
     解码只有 4-10 tok/s、长输入首字要 70 秒以上。所以只剩手工中转。

     ---- 两个必须做对的点 ----
     1) 提示词要自带全部规则。用户那边没有 system 角色，规则必须拼进同一段
        文本里，否则 App 不知道要输出 JSON。
     2) 解析沿用同一套（extractJson → normalizeDish），一行都不新写。
        粘回来的东西比正常输出脏得多：可能带 ```json 围栏、带"好的，我来推荐"
        这种开场白、可能被 App 的联网搜索改写成散文、也可能被截断。
        这些情况 extractJson 本来就在容忍，重写一份只会漏掉其中几种。
     ------------------------------------------------------------------ */

  /* 给用户复制的那段完整提示词。 */
  function ownPrompt(ctx) {
    return SYS_RULES + '\n\n' + buildUserPrompt(ctx) + '\n\n' +
      '（直接输出上面那个 JSON，不要任何解释、不要 markdown 代码块标记。）';
  }

  /* 把用户粘回来的文本，解析成和站内生成**完全同构**的菜。
     材料有没有、能不能做、缺几样，全走同一套 normalizeDish 判定，
     所以结果区的渲染、分组、筛选一行都不用改。 */
  function ingestExternal(text, ctx) {
    const t = String(text || '').trim();
    if (!t) throw new Error('还没粘贴内容。');

    ctx = ctx || {};
    const pantryNorms = buildPantryNorms(ctx);
    const allow = ctx.matchesAll ? 0 : Math.max(0, Number(ctx.allowMissing) || 0);
    const avoidNorms = (ctx.avoidNames || []).map(normName).filter(Boolean);

    /* 解不出来时不要只说"格式不对"—— 用户没法照做。
       常见原因是只复制了一半（App 的长回复被折叠了）。 */
    let arr;
    try {
      arr = cleanArr(extractJson(t).dishes, 24);
    } catch (e) {
      throw new Error('这段内容里没找到菜。确认整段回复都复制过来了 —— ' +
        '手机上长回复常常是折叠的，要点开"展开"或长按全选再复制。');
    }
    if (!arr.length) {
      throw new Error('这段内容里没有菜。粘回来的应该是 AI 给出的那个 JSON。');
    }

    const dishes = [];
    const seen = {};
    /* 被"避重"挡掉的条数单独数一下。全是重复的时候要能说出**是重复** ——
       只说"认不出来"会让用户以为是自己复制错了，然后反复重试同一段。 */
    let dupDropped = 0;
    arr.forEach(function (d) {
      const dd = normalizeDish(d, pantryNorms, allow);
      if (!dd.name || dd.name === '未命名料理') return;
      if (seen[dd.id]) return;
      if (avoidNorms.indexOf(normName(dd.name)) >= 0) { dupDropped++; return; }
      seen[dd.id] = 1;
      dishes.push(dd);
    });
    if (!dishes.length) {
      if (dupDropped) {
        throw new Error('这段内容和上一批重了（' + dupDropped + ' 道都是已经给过的菜）。' +
          '在手机上让它再换一批，或者把上面的目标改成「正经推荐」。');
      }
      throw new Error('粘回来的菜都没能认出来，换一段再试一次。');
    }

    return {
      /* 上层拿这份结果的字段名保持不变，改起来最省事。
         这份菜是**用户自己的 AI** 出的，不是站里算的 —— 站里已经没有模型了。 */
      model: '你自己的 AI',
      modelId: 'external',
      dishes: dishes,
      allowMissing: allow,
      angleId: ctx.angleId,
      angleLabel: ctx.angleLabel,
      mode: ctx.mode === 'explore' ? 'explore' : 'stable',
      raw: t,
    };
  }

  window.KF.ai = {
    basePantry: BASE_PANTRY,
    materialTypes: MATERIAL_TYPES,
    tutorials: tutorials,
    customTutorial: customTutorial,
    meals: MEALS,
    mealLabel: mealLabel,
    guessMeal: guessMeal,
    mealHint: MEAL_HINT,
    timeContext: timeContext,
    /* 第二部分「换换口味」用得到的三样：方向清单、抽方向、抽扰动。
       导出是为了能在测试里钉住"每次抽到的确实不一样"这件事。 */
    angles: ANGLES,
    pickAngle: pickAngle,
    pickTwist: pickTwist,
    angleLabel: angleLabel,
    angleHint: angleHint,
    buildUserPrompt: buildUserPrompt,
    /* 「用你自己的 AI」粘贴式的两头，也是**站里唯一的 AI 用法**：
       ownPrompt 生成要复制走的提示词，ingestExternal 把粘回来的文本解析成菜。
       导出是为了能在测试里单独验这两步（不用真的去手动复制粘贴一轮）。 */
    ownPrompt: ownPrompt,
    ingestExternal: ingestExternal,
    sysRules: SYS_RULES,
    normalizeDish: normalizeDish,
    safeUrl: safeUrl,
    isBlocked: isBlocked,
    normName: normName,
    hasMaterial: hasMaterial,
    dishId: dishId,
    extractCompleteDishes: extractCompleteDishes,
  };
})();
