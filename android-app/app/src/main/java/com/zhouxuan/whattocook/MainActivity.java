package com.zhouxuan.whattocook;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.view.KeyEvent;
import android.view.ViewGroup;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import androidx.webkit.WebViewAssetLoader;
import androidx.webkit.WebViewClientCompat;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.regex.Pattern;

/**
 * 一个「只有一个 WebView」的壳，把站点的整套文件装进安装包里。
 *
 * 它做四件事，缺一件这个 App 就是残的：
 *
 *   1. 用 WebViewAssetLoader 把安装包里的文件当成一个正经的 https 站点喂给页面。
 *      ⚠️ 不能图省事直接 loadUrl("file:///android_asset/index.html")：
 *         那样页面是 file:// 源，站里的 fetch 会被同源策略拦掉，
 *         localStorage 在 file:// 下也不可靠 —— 而菜单、食材、点单记录
 *         全存在 localStorage 里。换成一个假域名（appassets.androidplatform.net）
 *         之后，fetch 和 localStorage 的行为和线上站一模一样。
 *
 *   2. 给页面挂一条**不经浏览器的网络通道**（下面的 httpRequest）。
 *      这是这个 App 里最要紧的一块，理由见那个方法上面的长注释。
 *      没有它，家人点完菜发不出去、下厨的人那边也收不到 ——
 *      「自动收单」整条废掉，而且不报错，只是永远等不到。
 *
 *   3. 处理 window.open 和站外链接。站里的「看教程」是 window.open 打开的，
 *      WebView 默认**静默丢弃**这个请求（不弹、不报错、什么都不发生），
 *      表现就是"点了没反应"。这里统一交给系统浏览器去开。
 *
 *   4. 返回键先退页面自己的历史（站里是 #哈希 路由），退到头了再退出 App。
 */
public class MainActivity extends Activity {

    /** 假的本地域名，配合 WebViewAssetLoader 使用 */
    private static final String ORIGIN_HOST = "appassets.androidplatform.net";
    private static final String ORIGIN = "https://" + ORIGIN_HOST;

    /**
     * 真后端（站点那套 Cloudflare Pages + _worker.js）的地址。
     * ⚠️ 换了 Cloudflare 项目名 / 换了域名，这里要改，
     *    同时把 assets/net.js 里的 API_BASE 一起改掉，两处必须一致。
     */
    private static final String API_ORIGIN = "https://what-to-cook-bi7.pages.dev";

    private static final int TIMEOUT_MS = 6000;         /* 和 net.js 里的 TIMEOUT 对齐 */
    private static final int MAX_RESPONSE = 4 * 1024 * 1024;
    private static final Pattern ID_OK = Pattern.compile("^[A-Za-z0-9_]{1,32}$");

    private WebView web;

    @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);

        web = new WebView(this);
        setContentView(web, new ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        WebSettings st = web.getSettings();
        st.setJavaScriptEnabled(true);
        /* 本地存储不开，菜单 / 食材 / 点单记录一样都存不下来。命根子，别动。 */
        st.setDomStorageEnabled(true);
        st.setDatabaseEnabled(true);
        st.setTextZoom(100);                 // 不理系统的字体放大，免得排版被撑坏
        st.setUseWideViewPort(true);
        st.setLoadWithOverviewMode(true);
        st.setBuiltInZoomControls(false);
        st.setDisplayZoomControls(false);
        st.setJavaScriptCanOpenWindowsAutomatically(true);   // 站里的 window.open 才放得行（下面接住它）
        st.setAllowFileAccess(false);        // 页面不经 file:// 读文件（本地资源走上面那个 https 假域名）
        st.setAllowContentAccess(true);
        st.setCacheMode(WebSettings.LOAD_DEFAULT);

        final WebViewAssetLoader loader = new WebViewAssetLoader.Builder()
                .setDomain(ORIGIN_HOST)
                .addPathHandler("/assets/", new WebViewAssetLoader.AssetsPathHandler(this))
                .build();

        web.setWebViewClient(new WebViewClientCompat() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView v, WebResourceRequest req) {
                return loader.shouldInterceptRequest(req.getUrl());
            }

            /* 站外的链接（比如菜谱教程）别在壳里开 —— 壳里没有地址栏、
               没有返回按钮，开进去就出不来了。一律交给系统浏览器。 */
            @Override
            public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest req) {
                Uri u = req.getUrl();
                if (u == null) return false;
                if (ORIGIN_HOST.equals(u.getHost())) return false;   // 站内，照常
                openExternal(u);
                return true;
            }
        });

        web.setWebChromeClient(new WebChromeClient() {
            /* window.open 走的是这条路。默认实现是把它整个丢掉 ——
               不弹窗、不报错、什么都不发生，最难查的那种"点了没反应"。
               接法：塞一个一次性的 WebView 进去，等它拿到地址就交给浏览器。 */
            @Override
            public boolean onCreateWindow(WebView view, boolean isDialog,
                                          boolean isUserGesture, android.os.Message resultMsg) {
                final WebView probe = new WebView(MainActivity.this);
                probe.setWebViewClient(new WebViewClient() {
                    @Override
                    public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest req) {
                        openExternal(req.getUrl());
                        v.destroy();
                        return true;
                    }
                });
                try {
                    ((WebView.WebViewTransport) resultMsg.obj).setWebView(probe);
                    resultMsg.sendToTarget();
                    return true;
                } catch (Exception e) {
                    probe.destroy();
                    return false;
                }
            }
        });

        web.addJavascriptInterface(new ShellBridge(), "AndroidShell");

        if (saved == null) {
            web.loadUrl(ORIGIN + "/assets/index.html");
        } else {
            web.restoreState(saved);
        }
    }

    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        web.saveState(out);
    }

    /** 返回键：先退页面自己的历史（站里是 #哈希 路由），退到头了再退出 App */
    @Override
    public boolean onKeyDown(int code, KeyEvent e) {
        if (code == KeyEvent.KEYCODE_BACK && web != null && web.canGoBack()) {
            web.goBack();
            return true;
        }
        return super.onKeyDown(code, e);
    }

    @Override
    protected void onDestroy() {
        if (web != null) {
            web.removeJavascriptInterface("AndroidShell");
            web.destroy();
            web = null;
        }
        super.onDestroy();
    }

    private void openExternal(Uri u) {
        if (u == null) return;
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, u));
        } catch (Exception e) {
            Toast.makeText(this, "打不开这个链接：" + u, Toast.LENGTH_SHORT).show();
        }
    }

    /* ======================================================================
       给页面用的桥
       ======================================================================

       页面在假域名（appassets.androidplatform.net）上，站里的请求用的是
       **相对地址** `/api/...` —— 在壳里会指到壳自己身上，那边没有后端，
       必然 404。而让页面的 fetch 直接去连真后端也不行：真后端**故意**
       不返回任何 CORS 头（见 _worker.js 里「安全边界」那段，那是拦着
       别的网站顶着访客身份往你家菜单塞点单的），跨域请求会被浏览器拦下。

       所以这里由**原生代码**去发这条 HTTP 请求。原生发请求不涉及同源策略，
       CORS 这回事根本不存在 —— 后端也就不必为了壳去开那个口子。

       两个约定：
         · 页面的调法：AndroidShell.httpRequest(id, method, url, body)
           返回值为空（void）；原生做完会反过来调页面的
           window.KF_HTTP.done(id, '{"ok":true,"status":200,"body":"..."}')
         · 一律**安静地失败**：连不上、超时、返回不是 JSON —— 页面收到的
           都是 ok:false 或干脆没回调（页面自己有超时兜底），
           调用方只需要判 null，退回离线通道，不报错、不白屏。

       为什么用 id 而不是"一次性回调"：下厨端每 8 秒轮询一次，加上连点，
       请求是可能并发的，不编号会串台。
       ====================================================================== */
    private class ShellBridge {

        @JavascriptInterface
        public void httpRequest(final String id, final String method,
                                final String url, final String body) {
            /* id 是页面上编的序号，只用来对号入座。
               校验一下，别让它有机会拼出别的 JS 来（虽然下面用了 quote，
               但那道防线不该只靠一处）。 */
            if (id == null || !ID_OK.matcher(id).matches()) return;

            /* ⚠️ 白名单。桥能发任意 HTTP 请求，一旦页面被注入，
               就成了一个"想打哪打哪"的跳板。只放行真后端这一个域，
               路径也必须在 /api/ 下。 */
            if (url == null || !url.startsWith(API_ORIGIN + "/api/")) return;

            final String m = "POST".equals(method) ? "POST" : "GET";

            new Thread(new Runnable() {
                @Override
                public void run() {
                    final String payload = doRequest(m, url, body);
                    final WebView w = web;
                    if (w == null) return;
                    w.post(new Runnable() {
                        @Override
                        public void run() {
                            if (web == null) return;
                            try {
                                String js = "window.KF_HTTP&&window.KF_HTTP.done("
                                        + JSONObject.quote(id) + ","
                                        + JSONObject.quote(payload) + ")";
                                web.evaluateJavascript(js, null);
                            } catch (Exception e) {
                                /* 回调失败就当这条请求没成 —— 页面那边有自己的超时 */
                            }
                        }
                    });
                }
            }).start();
        }
    }

    /** 真正发请求的地方。任何异常都变成一句 ok:false，不往外抛。 */
    private String doRequest(String method, String url, String body) {
        HttpURLConnection c = null;
        try {
            c = (HttpURLConnection) new URL(url).openConnection();
            c.setRequestMethod(method);
            c.setConnectTimeout(TIMEOUT_MS);
            c.setReadTimeout(TIMEOUT_MS);
            c.setInstanceFollowRedirects(false);
            c.setUseCaches(false);
            c.setRequestProperty("cache-control", "no-store");
            c.setRequestProperty("accept", "application/json");

            if ("POST".equals(method)) {
                byte[] b = (body == null ? "" : body).getBytes(StandardCharsets.UTF_8);
                c.setDoOutput(true);
                c.setFixedLengthStreamingMode(b.length);
                c.setRequestProperty("content-type", "application/json");
                OutputStream os = c.getOutputStream();
                os.write(b);
                os.flush();
                os.close();
            }

            int code = c.getResponseCode();
            InputStream in = (code >= 200 && code < 400) ? c.getInputStream() : c.getErrorStream();
            String text = readAll(in);

            JSONObject o = new JSONObject();
            o.put("ok", true);
            o.put("status", code);
            o.put("body", text);
            return o.toString();
        } catch (Exception e) {
            try {
                JSONObject o = new JSONObject();
                o.put("ok", false);
                o.put("why", e.getClass().getSimpleName());
                return o.toString();
            } catch (Exception e2) {
                return "{\"ok\":false}";
            }
        } finally {
            if (c != null) c.disconnect();
        }
    }

    /** 读干一个流。加个上限，免得对面返回个超大响应把内存吃了。 */
    private static String readAll(InputStream in) {
        if (in == null) return "";
        ByteArrayOutputStream bos = new ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        try {
            int n;
            while ((n = in.read(buf)) > 0) {
                if (bos.size() + n > MAX_RESPONSE) break;
                bos.write(buf, 0, n);
            }
        } catch (Exception e) {
            /* 读到一半断了也不要紧：页面那边 JSON.parse 失败会当 null 处理 */
        } finally {
            try { in.close(); } catch (Exception e) { }
        }
        return new String(bos.toByteArray(), StandardCharsets.UTF_8);
    }
}
