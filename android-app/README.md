# 安卓安装包（android-app）

把站点的整套文件装进一个 APK，给不方便记网址、或者担心手机清缓存的人用。

**这里不手工编译。** 本机没有 JDK / Android SDK，而安卓 SDK 的官方下载源
在国内基本拉不动；实际打包跑在 GitHub Actions 上，见仓库根目录的
`.github/workflows/android.yml`。

- 每次改到站点文件（`index.html` / `assets/` / `manifest.json` / `version.txt`）
  并推到 `main`，会自动出一版新的 APK
- 产物挂在 **Release `apk-latest`** 上，直链固定不变：

  ```
  https://github.com/zhouxuan078-max/what-to-cook/releases/latest/download/WhatToCook.apk
  ```

  文件名用纯英文，是为了这条直链不用转码、发给别人不别扭。

## 四条不能忘的约束

### 1. `keystore.p12` 绝对不能重新生成

安卓认「同一个 App」靠**签名**而不是名字。同一把钥匙签出来的新版装到旧版上
是「升级」，菜单、食材、点单记录都留着；换了钥匙系统就当成另一个 App，
直接拒绝安装 —— 只能先卸载（数据一起没）。

> ⚠️ 安卓工具链自动生成的 debug 钥匙**每次都不一样**，而 GitHub 的构建机
> 每次都是干净的 —— 所以不能图省事用 debug 签名，必须把钥匙固定下来放进仓库。
> `app/build.gradle` 里 release 和 debug **都用**这把钥匙，就是这个原因。

> 这把钥匙是公开的（仓库是公开的），也就是说理论上有人能签一个冒充新版装进来。
> 自用 / 家人之间传着用无所谓；哪天上应用商店，请换成存在 GitHub Secrets 里的私有钥匙。

### 2. 站点文件是**构建时**拷进 `assets/` 的

`app/src/main/assets/` 在 `.gitignore` 里，不提交。CI 每次从仓库根目录
`cp -r index.html manifest.json version.txt assets` 过去。

这样做的好处：站点改了，APK 自然跟着改，仓库里不用再存一份副本，也不会出现
「两边不一致」。代价是**不能在本机直接编译**（没有 assets，得先手动拷一次）。

> `_worker.js` 和 `_routes.json` **不搬** —— 那是 Cloudflare 那边服务端要用的
> 东西，打进 APK 没有意义。

### 3. ★ 壳里那条网络通道（这个 App 最要紧的一块）

**没有它，这个 App 就是个残废**：家人点完「生成点单」发不出去，下厨的人那边
也永远收不到。而且它坏掉的表现是**不报错、不弹提示、什么都不发生** ——
最难查的那种。

问题出在两处，必须一起看：

- 页面在壳里跑在假域名 `appassets.androidplatform.net` 上，
  而站里的请求写的是**相对地址** `/api/...` —— 在壳里会指到壳自己身上，
  那边没有后端，必然 404。
- 那让页面的 `fetch` 直接去连真后端呢？**不行**：真后端**故意**不返回任何
  CORS 头（见 `_worker.js` 里「安全边界」那段，那是拦着别的网站顶着访客身份
  往你家菜单塞点单的），跨域请求会被浏览器拦下。

**所以走的是第三条路：让原生代码去发这条 HTTP 请求。**
原生发请求不涉及同源策略，CORS 这回事根本不存在 —— 后端也就不必为了 App
去开那个口子。

| 这一侧 | 在哪 | 干什么 |
|---|---|---|
| 页面 | `assets/net.js` 的 `reqViaShell()` / `window.KF_HTTP.done()` | 认准壳、把请求交给桥、按编号等回调 |
| 壳 | `MainActivity.ShellBridge.httpRequest()` | 在线程里发 HTTP，发完 `evaluateJavascript` 回调页面 |

两个约定：

- 页面的调法：`AndroidShell.httpRequest(id, method, url, body)`（无返回值）
- 原生做完调：`window.KF_HTTP.done(id, '{"ok":true,"status":200,"body":"..."}')`

用 `id` 编号而不是一次性回调，是因为下厨端每 8 秒轮询一次、加上连点，
请求是可能并发的，不编号会**串台**。

**判据必须是 `httpRequest`，不能是「有没有 AndroidShell」。**
另一个壳（英语台那个）也挂了 `AndroidShell`，但只有 `saveText` ——
拿它当判据，网页那边就会莫名其妙改走一条不存在的通道。
`_验收_壳.js` 的 F 段专门验这一条。

> 🔴 **地址有两处，必须一致**，改一个就得改另一个：
> - `assets/net.js` 里的 `API_BASE`
> - `MainActivity.java` 里的 `API_ORIGIN`（它同时是桥的白名单 ——
>   桥能发任意 HTTP 请求，不设白名单等于给页面开了个"想打哪打哪"的跳板）
>
> CI 里有一道检查会把这两处对一下，不一致就直接失败。

### 4. `window.open` 在 WebView 里是**哑的**，必须自己接住

站里「看教程」那些按钮是 `window.open(url, '_blank', ...)` 打开的。
WebView 默认**静默丢弃**这个请求：不弹窗、不报错、什么都不发生 ——
表现就是"点了没反应"。

`MainActivity` 里用 `WebChromeClient.onCreateWindow` 塞一个一次性的 WebView
把地址接住，再交给系统浏览器打开。另外 `shouldOverrideUrlLoading` 把站外链接
也一并交给浏览器 —— 壳里没有地址栏、没有返回键，开进去就出不来了。

## 已知的能力差异

- **「看教程」会在系统浏览器里打开**，不在 App 里。这是故意的（见上一条）。
- **自动收单要联网。** 断网时 App 照常能开菜单、能看食材、能配额，
  只是点单发不出去 —— 这时页面会安静地退回「生成链接 / 二维码」那条离线通道，
  和网页版的行为一致。
- **不处理分享链接的深链。** 家人收到 `https://what-to-cook-bi7.pages.dev/#/o/...`
  这样的链接，点开会进浏览器（而不是 App）。那条路本身是通的
  （浏览器里就是同源），所以没有加 Intent 过滤。

## 本地试打（可选）

本机要打的话（已装好 JDK 17 + SDK 34 + Gradle 8.7）：

```bash
# 1. 把站点文件搬进去（平时由 CI 做）
rm -rf android-app/app/src/main/assets
mkdir -p android-app/app/src/main/assets
cp -r index.html manifest.json version.txt assets android-app/app/src/main/assets/

# 2. 写 local.properties（sdk.dir=...）

# 3. 打包
cd android-app
gradle assembleRelease --no-daemon -Pvc=1 -Pvn=1.0
```

产物在 `android-app/app/build/outputs/apk/release/app-release.apk`。

> `gradle.properties` 里有 `android.overridePathCheck=true`：工程放在带中文的
> 路径下（比如 `网站库\吃什么（what-to-cook）\`）时，AGP 默认会拒绝开工。
