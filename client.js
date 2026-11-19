// Client 半：「设置 → 邮件整理」（邮件 / 报告 / 自动）+ 全局通知与报告浮层。
//
// 手写 lazy-CJS bundle：脚本执行时只注册 factory，模块体在 materialize 时才运行。
// 只依赖 React 与 DSH 既有服务（slots / remote），不引入 primitives。
//
// 通知：client 常驻轮询未读报告，有新报告就在 shell.overlay 里弹一张卡，点开看全文。
window.__ModuleLoader__.load({
  id: "@skyrocks/dsh-mail-digest",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    const React = require("react");

    // Client 只声明调用形状；真正的校验在 Host 侧完成。
    const passThrough = () => ({ parse: (value) => value });
    const codec = (typeSymbol) => ({ mode: "strict", typeSymbol, create: passThrough });
    const parameter = (name) => ({ name, wire: name, source: "json", codec: codec(`@skyrocks/dsh-mail-digest#${name}`) });

    const METHODS = ["status", "save", "removeAccount", "probe", "fetch", "list", "read", "thread", "file", "summarize", "report", "reports", "auto", "runNow", "reportContent", "openInBrowser"];
    const REMOTE = {
      package: "@skyrocks/dsh-mail-digest",
      descriptors: METHODS.map((method) => ({
        id: `@skyrocks/dsh-mail-digest#mailDigest/${method}`,
        service: "mailDigest",
        namespace: "mailDigest",
        method,
        invocation: { kind: "direct" },
        parameters: method === "status" ? [] : [parameter("request")],
        result: codec(`@skyrocks/dsh-mail-digest#MailDigest${method[0].toUpperCase()}${method.slice(1)}Result`)
      }))
    };

    const HOURS = [1, 2, 4, 6, 8, 12, 24, 48, 168];

    // 侧边栏里的报告面板：资源地址 dsh-resource://mail-digest-report/<报告 id>
    const REPORT_KIND = "mail-digest-report";
    const REPORT_TYPE_ID = "@skyrocks/dsh-mail-digest/report";
    const REPORT_PREFIX = `dsh-resource://${REPORT_KIND}/`;

    // 常用邮箱服务商的 IMAP 参数：选一个就填好，只留「其他」需要手填。
    const PROVIDERS = [
      { id: "qq", label: "QQ 邮箱", host: "imap.qq.com", port: 993, secure: true, domains: ["qq.com", "vip.qq.com", "foxmail.com"], hint: "需在 QQ 邮箱开启 IMAP，用授权码。" },
      { id: "exmail", label: "腾讯企业邮", host: "imap.exmail.qq.com", port: 993, secure: true, domains: [], hint: "用客户端专用密码；主机按企业域名填。" },
      { id: "163", label: "网易 163 邮箱", host: "imap.163.com", port: 993, secure: true, domains: ["163.com"], hint: "开启 IMAP 后用授权码。" },
      { id: "126", label: "网易 126 邮箱", host: "imap.126.com", port: 993, secure: true, domains: ["126.com"], hint: "开启 IMAP 后用授权码。" },
      { id: "yeah", label: "网易 yeah.net", host: "imap.yeah.net", port: 993, secure: true, domains: ["yeah.net"], hint: "开启 IMAP 后用授权码。" },
      { id: "gmail", label: "Gmail", host: "imap.gmail.com", port: 993, secure: true, domains: ["gmail.com", "googlemail.com"], hint: "需两步验证 + 应用专用密码；国内可能连不通。" },
      { id: "outlook", label: "Outlook / Hotmail", host: "outlook.office365.com", port: 993, secure: true, domains: ["outlook.com", "hotmail.com", "live.com", "msn.com"], hint: "个人号也可用 imap-mail.outlook.com。" },
      { id: "icloud", label: "iCloud 邮箱", host: "imap.mail.me.com", port: 993, secure: true, domains: ["icloud.com", "me.com", "mac.com"], hint: "需 App 专用密码。" },
      { id: "yahoo", label: "Yahoo 邮箱", host: "imap.mail.yahoo.com", port: 993, secure: true, domains: ["yahoo.com"], hint: "需应用密码。" },
      { id: "aliyun", label: "阿里云邮箱 / 阿里企业邮", host: "imap.aliyun.com", port: 993, secure: true, domains: ["aliyun.com"], hint: "企业邮按自己的域名填主机。" },
      { id: "sina", label: "新浪邮箱", host: "imap.sina.com", port: 993, secure: true, domains: ["sina.com", "sina.cn"], hint: "需在网页版开启 IMAP。" },
      { id: "sohu", label: "搜狐邮箱", host: "imap.sohu.com", port: 993, secure: true, domains: ["sohu.com"], hint: "需在网页版开启 IMAP。" },
      { id: "other", label: "其他（手动填）", host: "", port: 993, secure: true, domains: [], hint: "自己填服务器和端口。" }
    ];

    /** 从主机名反查是哪家；认不出来就当「其他」。 */
    function providerIdOf(host) {
      const value = String(host ?? "").trim().toLowerCase();
      if (value === "") return "";
      const hit = PROVIDERS.find((item) => item.host !== "" && item.host === value);
      return hit === undefined ? "other" : hit.id;
    }

    /** 从账号的域名猜服务商，只用于「还没选过」的时候。 */
    function providerIdOfAddress(address) {
      const value = String(address ?? "").trim().toLowerCase();
      const at = value.lastIndexOf("@");
      if (at < 0) return "";
      const domain = value.slice(at + 1);
      const hit = PROVIDERS.find((item) => item.domains.includes(domain));
      return hit === undefined ? "" : hit.id;
    }

    function providerById(id) {
      return PROVIDERS.find((item) => item.id === id);
    }

    const CSS = [
      ".dsh-md-section{display:flex;flex-direction:column;gap:12px;padding:4px 2px 24px;}",
      ".dsh-md-head{display:flex;align-items:baseline;justify-content:space-between;gap:12px;flex-wrap:wrap;}",
      ".dsh-md-head h3{margin:0;font-size:13px;font-weight:600;}",
      ".dsh-md-head-actions{display:flex;gap:6px;flex-wrap:wrap;}",
      ".dsh-md-tabs{display:flex;gap:2px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.18));}",
      ".dsh-md-tab{height:30px;padding:0 12px;border:0;border-bottom:2px solid transparent;background:transparent;color:var(--dsw-alias-label-secondary,#6b7280);font-size:12px;cursor:pointer;}",
      ".dsh-md-tab.is-on{color:var(--dsw-alias-label-primary,#1f2329);border-bottom-color:var(--dsw-alias-state-business-primary,#4d6bfe);}",
      ".dsh-md-dot{display:inline-block;min-width:16px;padding:0 4px;margin-left:6px;border-radius:999px;background:var(--dsw-alias-state-error-primary,#e5484d);color:#fff;font-size:10px;line-height:16px;text-align:center;}",
      ".dsh-md-meta{font-size:11px;color:var(--dsw-alias-label-tertiary,#8a8f98);line-height:1.6;word-break:break-all;}",
      ".dsh-md-chips{display:flex;gap:6px;flex-wrap:wrap;}",
      ".dsh-md-chip{height:24px;max-width:190px;padding:0 10px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.3));background:transparent;color:inherit;font-size:11.5px;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}",
      ".dsh-md-chip:hover{background:color-mix(in srgb,currentColor 8%,transparent);}",
      ".dsh-md-chip.is-on{color:#fff;background:var(--dsw-alias-state-business-primary,#4d6bfe);border-color:transparent;}",
      ".dsh-md-list{display:flex;flex-direction:column;gap:1px;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.18));border-radius:10px;overflow:hidden;background:var(--dsw-alias-border-l1,rgba(127,127,127,.18));}",
      ".dsh-md-row{background:var(--dsw-alias-bg-module-platform,#fff);}",
      ".dsh-md-row-head{display:flex;align-items:center;gap:10px;padding:10px 12px;cursor:pointer;}",
      ".dsh-md-row-head:hover{background:color-mix(in srgb,currentColor 4%,transparent);}",
      ".dsh-md-row-head:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#4d6bfe);outline-offset:-2px;}",
      ".dsh-md-row-main{flex:1;min-width:0;}",
      ".dsh-md-row-title{display:flex;align-items:center;gap:6px;font-size:12.5px;color:var(--dsw-alias-label-primary,#1f2329);}",
      ".dsh-md-row-title span{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}",
      ".dsh-md-row-snippet{margin-top:2px;font-size:11.5px;color:var(--dsw-alias-label-secondary,#6b7280);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}",
      ".dsh-md-row-sub{margin-top:2px;font-size:11px;color:var(--dsw-alias-label-tertiary,#8a8f98);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}",
      ".dsh-md-badges{display:flex;gap:4px;flex:none;flex-wrap:wrap;justify-content:flex-end;max-width:46%;}",
      ".dsh-md-row-actions{display:flex;gap:2px;flex:none;align-items:center;}",
      ".dsh-md-acc{display:flex;align-items:center;gap:10px;padding:9px 10px;background:var(--dsw-alias-bg-module-platform,#fff);}",
      ".dsh-md-acc-main{flex:1;min-width:0;cursor:pointer;padding:3px 6px;border-radius:7px;}",
      ".dsh-md-acc-main:hover{background:color-mix(in srgb,currentColor 4%,transparent);}",
      ".dsh-md-acc-main.is-on{background:color-mix(in srgb,var(--dsw-alias-state-business-primary,#4d6bfe) 10%,transparent);}",
      ".dsh-md-acc-main:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#4d6bfe);outline-offset:-2px;}",
      ".dsh-md-panel{display:flex;flex-direction:column;gap:14px;padding:14px;height:100%;overflow:auto;font-size:12.5px;line-height:1.7;color:var(--dsw-alias-label-primary,#1f2329);}",
      ".dsh-md-panel-head{display:flex;align-items:flex-start;gap:8px;flex-wrap:wrap;}",
      ".dsh-md-panel-title{font-size:13px;font-weight:600;flex:1;min-width:0;}",
      ".dsh-md-panel-meta{font-size:11px;color:var(--dsw-alias-label-tertiary,#8a8f98);}",
      ".dsh-md-panel h4{margin:2px 0 0;font-size:11px;letter-spacing:.04em;color:var(--dsw-alias-label-tertiary,#8a8f98);}",
      ".dsh-md-panel section{display:flex;flex-direction:column;gap:8px;}",
      ".dsh-md-panel ol{margin:0;padding-left:18px;display:flex;flex-direction:column;gap:6px;}",
      ".dsh-md-panel ul{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:8px;}",
      ".dsh-md-panel li b{font-weight:600;}",
      ".dsh-md-panel .dsh-md-panel-note{color:var(--dsw-alias-label-secondary,#6b7280);font-size:11.5px;}",
      ".dsh-md-panel .dsh-md-panel-sub{font-size:11px;color:var(--dsw-alias-label-tertiary,#8a8f98);}",
      ".dsh-md-panel .dsh-md-panel-card{padding:8px 10px;border-radius:8px;background:color-mix(in srgb,currentColor 4%,transparent);display:flex;flex-direction:column;gap:3px;}",
      ".dsh-md-panel .dsh-md-chiprow{display:flex;flex-wrap:wrap;gap:5px;}",
      ".dsh-md-panel .dsh-md-mini{font-size:10.5px;padding:1px 7px;border-radius:999px;background:color-mix(in srgb,currentColor 8%,transparent);}",
      ".dsh-md-panel .dsh-md-mini.is-high{color:var(--dsw-alias-state-error-primary,#e5484d);}",
      ".dsh-md-panel .dsh-md-mini.is-reply{color:var(--dsw-alias-state-warning-primary,#d97706);}",
      ".dsh-md-frame{flex:1;width:100%;min-height:420px;border:0;border-radius:8px;background:transparent;color-scheme:light dark;}",
      ".dsh-md-badge{flex:none;padding:1px 6px;border-radius:999px;font-size:10px;line-height:16px;border:1px solid transparent;white-space:nowrap;}",
      ".dsh-md-badge.is-tag{color:var(--dsw-alias-label-secondary,#6b7280);background:color-mix(in srgb,currentColor 8%,transparent);}",
      ".dsh-md-badge.is-high{color:var(--dsw-alias-state-error-primary,#e5484d);background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#e5484d) 12%,transparent);}",
      ".dsh-md-badge.is-reply{color:var(--dsw-alias-state-warning-primary,#d97706);background:color-mix(in srgb,var(--dsw-alias-state-warning-primary,#d97706) 14%,transparent);}",
      ".dsh-md-badge.is-new{color:var(--dsw-alias-state-business-primary,#4d6bfe);background:color-mix(in srgb,var(--dsw-alias-state-business-primary,#4d6bfe) 12%,transparent);}",
      ".dsh-md-badge.is-filed{color:var(--dsw-alias-state-success-primary,#2f9e44);background:color-mix(in srgb,var(--dsw-alias-state-success-primary,#2f9e44) 12%,transparent);}",
      ".dsh-md-body{padding:0 12px 12px;display:flex;flex-direction:column;gap:10px;}",
      ".dsh-md-text{margin:0;padding:10px;border-radius:8px;background:color-mix(in srgb,currentColor 4%,transparent);font-size:12px;line-height:1.6;white-space:pre-wrap;word-break:break-word;max-height:260px;overflow:auto;color:var(--dsw-alias-label-primary,#1f2329);}",
      ".dsh-md-controls{display:flex;gap:8px;flex-wrap:wrap;align-items:center;}",
      ".dsh-md-controls select,.dsh-md-controls input[type=text]{height:24px;padding:0 6px;border-radius:7px;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.3));background:transparent;color:inherit;font-size:11.5px;max-width:240px;}",
      ".dsh-md-saved{font-size:11px;color:var(--dsw-alias-state-success-primary,#2f9e44);}",
      ".dsh-md-inline{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--dsw-alias-label-primary,#1f2329);}",
      ".dsh-md-inline select,.dsh-md-inline input[type=time]{height:26px;padding:0 6px;border-radius:7px;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.3));background:transparent;color:inherit;font-size:12px;}",
      ".dsh-md-toolbar{display:flex;align-items:center;justify-content:space-between;gap:10px;}",
      ".dsh-md-inline.is-spaced{margin-top:8px;}",
      ".dsh-md-grid.is-spaced{margin-top:8px;}",
      ".dsh-md-subhead{margin:8px 0 0;font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary,#6b7280);}",
      ".dsh-md-notice-head{display:flex;align-items:flex-start;gap:8px;}",
      ".dsh-md-notice-x{flex:none;margin-left:auto;border:0;background:transparent;color:var(--dsw-alias-label-tertiary,#8a8f98);font-size:14px;line-height:1;cursor:pointer;padding:2px 4px;}",
      ".dsh-md-hint{font-size:10.5px;color:var(--dsw-alias-label-tertiary,#8a8f98);line-height:1.6;}",
      ".dsh-md-empty{padding:28px 12px;text-align:center;font-size:12px;color:var(--dsw-alias-label-tertiary,#8a8f98);line-height:1.9;}",
      ".dsh-md-foot{font-size:11px;color:var(--dsw-alias-label-tertiary,#8a8f98);}",
      ".dsh-md-error{padding:8px 10px;border-radius:8px;font-size:11.5px;line-height:1.5;color:var(--dsw-alias-state-error-primary,#e5484d);background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#e5484d) 10%,transparent);}",
      ".dsh-md-ok{padding:8px 10px;border-radius:8px;font-size:11.5px;line-height:1.5;color:var(--dsw-alias-state-success-primary,#2f9e44);background:color-mix(in srgb,var(--dsw-alias-state-success-primary,#2f9e44) 10%,transparent);}",
      ".dsh-md-btn{height:30px;padding:0 14px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.3));background:transparent;color:inherit;font-size:12px;cursor:pointer;}",
      ".dsh-md-btn:hover{background:color-mix(in srgb,currentColor 8%,transparent);}",
      ".dsh-md-btn:disabled{opacity:.5;cursor:default;}",
      ".dsh-md-btn.is-primary{color:#fff;background:var(--dsw-alias-state-business-primary,#4d6bfe);border-color:transparent;}",
      ".dsh-md-btn.is-danger{color:#fff;background:var(--dsw-alias-state-error-primary,#e5484d);border-color:transparent;}",
      ".dsh-md-btn.is-link{padding:0 6px;height:24px;border-color:transparent;font-size:11.5px;color:var(--dsw-alias-state-business-primary,#4d6bfe);}",
      ".dsh-md-overlay{position:fixed;inset:0;z-index:2200;pointer-events:auto;display:flex;align-items:center;justify-content:center;padding:24px;background:rgba(0,0,0,.38);}",
      ".dsh-md-dialog{width:min(560px,100%);max-height:calc(100vh - 64px);overflow:auto;border-radius:12px;background:var(--dsw-alias-bg-module-platform,#fff);border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.22));box-shadow:0 18px 48px rgba(0,0,0,.26);color:var(--dsw-alias-label-primary,#1f2329);padding:18px;}",
      ".dsh-md-dialog h2{margin:0 0 12px;font-size:14px;font-weight:600;}",
      ".dsh-md-dialog.is-wide{width:min(760px,100%);}",
      ".dsh-md-dialog h4{margin:16px 0 8px;font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary,#6b7280);}",
      ".dsh-md-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px 12px;}",
      ".dsh-md-field{display:flex;flex-direction:column;gap:4px;min-width:0;}",
      ".dsh-md-field.is-wide{grid-column:1 / -1;}",
      ".dsh-md-field label{font-size:11px;color:var(--dsw-alias-label-secondary,#6b7280);}",
      ".dsh-md-field input,.dsh-md-field select{height:30px;padding:0 8px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.3));background:transparent;color:inherit;font-size:12px;min-width:0;}",
      ".dsh-md-field.is-check{flex-direction:row;align-items:center;gap:8px;grid-column:1 / -1;}",
      ".dsh-md-field.is-check input{height:auto;width:14px;}",
      ".dsh-md-field.is-check label{font-size:12px;color:inherit;}",
      ".dsh-md-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:16px;}",
      ".dsh-md-actions .dsh-md-spacer{flex:1;}",
      ".dsh-md-tagrow{display:flex;gap:6px;align-items:center;}",
      ".dsh-md-tagrow input{flex:1;height:26px;padding:0 8px;border-radius:7px;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.3));background:transparent;color:inherit;font-size:12px;min-width:0;}",
      ".dsh-md-notice{position:fixed;right:20px;bottom:20px;z-index:2100;pointer-events:auto;width:min(340px,calc(100vw - 40px));border-radius:12px;padding:14px 14px 12px;background:var(--dsw-alias-bg-module-platform,#fff);border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.22));box-shadow:0 14px 36px rgba(0,0,0,.24);color:var(--dsw-alias-label-primary,#1f2329);}",
      ".dsh-md-notice-title{font-size:12.5px;font-weight:600;}",
      ".dsh-md-notice-text{margin-top:4px;font-size:11.5px;line-height:1.6;color:var(--dsw-alias-label-secondary,#6b7280);}",
      ".dsh-md-notice-actions{display:flex;gap:8px;justify-content:flex-end;margin-top:10px;}",
      ".dsh-md-report{font-size:12.5px;line-height:1.75;color:var(--dsw-alias-label-primary,#1f2329);}",
      ".dsh-md-report h1{font-size:16px;font-weight:600;margin:0 0 10px;}",
      ".dsh-md-report h2{font-size:13.5px;font-weight:600;margin:16px 0 8px;}",
      ".dsh-md-report h3{font-size:12.5px;font-weight:600;margin:12px 0 6px;}",
      ".dsh-md-report p{margin:0 0 8px;white-space:pre-wrap;word-break:break-word;}",
      ".dsh-md-report ul{margin:0 0 10px;padding-left:18px;}",
      ".dsh-md-report li{margin:2px 0;}",
      ".dsh-md-report blockquote{margin:0 0 10px;padding:6px 10px;border-left:3px solid var(--dsw-alias-border-l1,rgba(127,127,127,.28));color:var(--dsw-alias-label-secondary,#6b7280);}"
    ].join("");

    function ensureStyle() {
      if (typeof document === "undefined") return () => {};
      const id = "dsh-md-style";
      if (document.getElementById(id) !== null) return () => {};
      const element = document.createElement("style");
      element.id = id;
      element.textContent = CSS;
      document.head.appendChild(element);
      return () => {
        element.remove();
      };
    }

    /** 极简共享快照。 */
    function createStore(initial) {
      const listeners = new Set();
      let value = initial;
      return {
        get: () => value,
        set(next) {
          value = next;
          for (const listener of listeners) listener();
        },
        subscribe(listener) {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        }
      };
    }

    function useStore(store) {
      return React.useSyncExternalStore(store.subscribe, store.get, store.get);
    }

    const revisionStore = createStore(0);
    const bumpRevision = () => revisionStore.set(revisionStore.get() + 1);

    // 全局浮层状态：通知 + 正在看的报告。
    const uiStore = createStore({ notice: null, unread: 0, items: [], report: null, busy: false, error: "" });
    // 设置页挂着的时候，报告阅读器就渲染在设置页里；否则交给全局浮层。
    const panelStore = createStore({ open: false });

    let ctxRef = null;
    let mountReady = Promise.resolve();
    let mountError = null;
    // 设置页会盖住会话，而右侧栏属于会话——记住最近一次在前台的那个会话 id。
    let lastSessionId = "";

    async function call(method, argument) {
      await mountReady;
      if (mountError !== null) {
        throw new Error(`邮件整理服务没连上：${mountError instanceof Error ? mountError.message : String(mountError)}`);
      }
      const remote = ctxRef === null ? undefined : ctxRef.get("remote.mailDigest");
      if (remote === undefined || remote === null) throw new Error("邮件整理服务不可用");
      const result = argument === undefined ? await remote[method]() : await remote[method](argument);
      if (!result || result.ok === false) {
        const reason = result && result.error ? result.error.message || String(result.error) : "操作失败，请重试";
        throw new Error(reason);
      }
      return result.value;
    }

    function notify(text, success) {
      try {
        const menus = ctxRef === null ? undefined : ctxRef.get("contextMenus");
        if (menus !== undefined && typeof menus.notify === "function") menus.notify(text, success);
      } catch {
        // toast 不可用就静默；操作已经完成。
      }
    }

    function stamp(value) {
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) return String(value ?? "").slice(0, 16);
      const pad = (number) => String(number).padStart(2, "0");
      const sameYear = date.getFullYear() === new Date().getFullYear();
      const day = `${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
      return `${sameYear ? day : `${date.getFullYear()}-${day}`} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
    }

    // ── 报告浮层 ────────────────────────────────────────────────────────────

    /** 行内：**粗体** 与 `代码`，其余按纯文本。 */
    function inlineNodes(text, keyPrefix) {
      const nodes = [];
      const pattern = /(\*\*[^*]+\*\*|`[^`]+`)/g;
      let last = 0;
      let match = pattern.exec(text);
      let index = 0;
      while (match !== null) {
        if (match.index > last) nodes.push(text.slice(last, match.index));
        const token = match[0];
        const key = `${keyPrefix}-${index}`;
        index += 1;
        if (token.startsWith("**")) nodes.push(React.createElement("strong", { key }, token.slice(2, -2)));
        else nodes.push(React.createElement("code", { key }, token.slice(1, -1)));
        last = match.index + token.length;
        match = pattern.exec(text);
      }
      if (last < text.length) nodes.push(text.slice(last));
      return nodes;
    }

    /** 把 Markdown 拆成几种块（标题 / 列表（两级）/ 引用 / 段落）。 */
    function renderMarkdown(text) {
      const lines = String(text ?? "").split("\n");
      const blocks = [];
      let items = null;
      let quote = null;

      const flushList = () => {
        if (items === null) return;
        const list = items;
        items = null;
        blocks.push(React.createElement(
          "ul",
          { key: `u${blocks.length}` },
          list.map((item, index) => React.createElement(
            "li",
            { key: `li${index}` },
            inlineNodes(item.text, `li${index}`),
            item.subs.length === 0
              ? null
              : React.createElement(
                  "ul",
                  null,
                  item.subs.map((sub, at) => React.createElement(
                    "li",
                    { key: `sub${at}` },
                    inlineNodes(sub, `sub${at}`)
                  ))
                )
          ))
        ));
      };

      const flushQuote = () => {
        if (quote === null) return;
        const text = quote.join(" ");
        quote = null;
        blocks.push(React.createElement("blockquote", { key: `q${blocks.length}` }, inlineNodes(text, `q${blocks.length}`)));
      };

      const flush = () => {
        flushList();
        flushQuote();
      };

      for (const raw of lines) {
        const line = raw.replace(/\u001b\[[0-9;]*m/g, "");
        if (line.trim() === "") {
          flush();
          continue;
        }
        if (line.startsWith("# ")) {
          flush();
          blocks.push(React.createElement("h1", { key: `h${blocks.length}` }, ...inlineNodes(line.slice(2), "h1")));
          continue;
        }
        if (line.startsWith("## ")) {
          flush();
          blocks.push(React.createElement("h2", { key: `h${blocks.length}` }, ...inlineNodes(line.slice(3), "h2")));
          continue;
        }
        if (line.startsWith("### ")) {
          flush();
          blocks.push(React.createElement("h3", { key: `h${blocks.length}` }, ...inlineNodes(line.slice(4), "h3")));
          continue;
        }
        if (line.startsWith("> ")) {
          flushList();
          quote ??= [];
          quote.push(line.slice(2));
          continue;
        }
        const indented = /^(\s{2,})-\s+(.*)$/.exec(line);
        if (indented !== null && items !== null && items.length > 0) {
          flushQuote();
          items[items.length - 1].subs.push(indented[2]);
          continue;
        }
        const bullet = /^\s*-\s+(.*)$/.exec(line);
        if (bullet !== null) {
          flushQuote();
          items ??= [];
          items.push({ text: bullet[1], subs: [] });
          continue;
        }
        flush();
        blocks.push(React.createElement("p", { key: `p${blocks.length}` }, ...inlineNodes(line, "p")));
      }
      flush();
      return blocks;
    }

    /** 把一份报告标成已读并让列表重拉。 */
    function markReportRead(id) {
      call("reports", { action: "read", id })
        .then(() => bumpRevision())
        .catch(() => {});
    }

    async function openReport(id, title) {
      seenReportIds.add(id);
      const sidebar = ctxRef === null ? undefined : ctxRef.get("sidebarRight");
      const address = `${REPORT_PREFIX}${encodeURIComponent(id)}`;

      if (sidebar !== undefined && sidebar !== null && typeof sidebar.openResource === "function") {
        // 会话在前台：直接开在它自己的右侧栏。
        try {
          sidebar.openResource(address, { kind: REPORT_KIND });
          markReportRead(id);
          uiStore.set({ ...uiStore.get(), notice: null });
          return "sidebar";
        } catch {
          // 设置页会盖住会话，on-screen Session 为空；试挂到最近那个会话
        }
        if (lastSessionId !== "" && typeof sidebar.openResourceIn === "function") {
          try {
            sidebar.openResourceIn(lastSessionId, address, { kind: REPORT_KIND });
            markReportRead(id);
            uiStore.set({ ...uiStore.get(), notice: null });
            // 设置页盖住了会话：开完把设置关掉，回到会话就能看到刚开的报告面板。
            try {
              const layout = ctxRef === null ? undefined : ctxRef.get("layout");
              if (layout !== undefined && layout !== null && typeof layout.selectPanel === "function") {
                layout.selectPanel(null);
              }
            } catch {
              // 关不掉设置页也正常，用户自己返回会话即可
            }
            return "behind";
          } catch {
            // 那个会话已经关掉了
          }
        }
      }

      // 侧栏开不了（比如正停在设置页）：直接给网页版，别让人干等。
      try {
        await call("openInBrowser", { id });
        markReportRead(id);
        uiStore.set({ ...uiStore.get(), notice: null });
        return "browser";
      } catch {
        // 浏览器也开不了，才退回页内浮层（浮层里同样渲染网页）
      }

      uiStore.set({ ...uiStore.get(), busy: true, error: "" });
      try {
        const value = await call("reportContent", { id });
        uiStore.set({
          ...uiStore.get(),
          notice: null,
          busy: false,
          report: {
            id,
            title: value.content?.title ?? title,
            markdown: "",
            html: typeof value.html === "string" ? value.html : ""
          }
        });
        markReportRead(id);
      } catch (failure) {
        uiStore.set({
          ...uiStore.get(),
          busy: false,
          error: failure instanceof Error ? failure.message : String(failure)
        });
      }
      return "overlay";
    }

    /** 把「已经在提示的那份」记成已提示，关掉之后不再弹。 */
    function acknowledge(notice) {
      if (notice !== null && notice.id) seenReportIds.add(notice.id);
    }

    function ReportOverlay({ insidePanel }) {
      const ui = useStore(uiStore);
      const panel = useStore(panelStore);
      const visible = (panel.open === true) === (insidePanel === true) && ui.report !== null;
      const closeRef = React.useRef(null);

      React.useEffect(() => {
        if (!visible) return undefined;
        closeRef.current?.focus();
        const onKey = (event) => {
          if (event.key === "Escape") uiStore.set({ ...uiStore.get(), report: null });
        };
        document.addEventListener("keydown", onKey);
        return () => document.removeEventListener("keydown", onKey);
      }, [visible, ui.report]);

      if (!visible) return null;
      const close = () => uiStore.set({ ...uiStore.get(), report: null });
      return React.createElement(
        "div",
        {
          className: "dsh-md-overlay",
          onMouseDown: (event) => {
            if (event.target === event.currentTarget) close();
          }
        },
        React.createElement(
          "div",
          {
            className: "dsh-md-dialog is-wide",
            role: "dialog",
            "aria-modal": "true",
            "aria-label": ui.report.title
          },
          ui.report.html !== undefined && ui.report.html !== ""
            ? React.createElement("iframe", {
                className: "dsh-md-frame",
                title: ui.report.title,
                sandbox: "",
                srcDoc: ui.report.html
              })
            : React.createElement("div", { className: "dsh-md-report" }, renderMarkdown(ui.report.markdown)),
          React.createElement(
            "div",
            { className: "dsh-md-actions" },
            React.createElement(
              "button",
              { type: "button", className: "dsh-md-btn is-primary", ref: closeRef, onClick: close },
              "关闭"
            )
          )
        )
      );
    }

    function NoticeOverlay({ insidePanel }) {
      const ui = useStore(uiStore);
      const panel = useStore(panelStore);
      // 和报告阅读器一样：设置页开着就渲染在设置页里，否则交给全局浮层。
      if ((panel.open === true) !== (insidePanel === true)) return null;
      if (ui.notice === null || ui.report !== null) return null;
      const notice = ui.notice;

      const dismiss = () => {
        acknowledge(notice);
        uiStore.set({ ...uiStore.get(), notice: null });
      };

      const others = Math.max(0, (ui.unread ?? 0) - 1);
      return React.createElement(
        "div",
        { className: "dsh-md-notice", role: "status" },
        React.createElement(
          "div",
          { className: "dsh-md-notice-head" },
          React.createElement("div", { className: "dsh-md-notice-title" }, `📬 ${notice.title}`),
          React.createElement(
            "button",
            { type: "button", className: "dsh-md-notice-x", "aria-label": "关掉这条提醒", onClick: dismiss },
            "×"
          )
        ),
        React.createElement(
          "div",
          { className: "dsh-md-notice-text" },
          notice.summary === "" ? "新报告已生成。" : notice.summary,
          others > 0 ? `（另有 ${others} 份未读）` : ""
        ),
        ui.error === "" ? null : React.createElement("div", { className: "dsh-md-error", role: "alert" }, ui.error),
        React.createElement(
          "div",
          { className: "dsh-md-notice-actions" },
          React.createElement("button", { type: "button", className: "dsh-md-btn is-link", disabled: ui.busy, onClick: dismiss }, "稍后"),
          React.createElement(
            "button",
            {
              type: "button",
              className: "dsh-md-btn is-primary",
              disabled: ui.busy,
              onClick: () => openReport(notice.id, notice.title)
            },
            ui.busy ? "打开中…" : "看报告"
          )
        )
      );
    }

    // ── 配置（页内表单，不是弹框）────────────────────────────────────────────

    function accountForm(account) {
      return {
        host: account.host ?? "",
        port: account.port ?? 993,
        secure: account.secure !== false,
        user: account.user ?? "",
        password: "",
        mailbox: account.mailbox ?? "INBOX",
        days: account.days ?? 30,
        limit: account.limit ?? 100,
        fromFilter: account.fromFilter ?? "",
        subjectFilter: account.subjectFilter ?? "",
        unseenOnly: account.unseenOnly === true
      };
    }

    function missingRequired(form) {
      return String(form.host ?? "").trim() === "" || String(form.user ?? "").trim() === "";
    }

    function field(label, control, hint, wide) {
      return React.createElement(
        "div",
        { className: wide === true ? "dsh-md-field is-wide" : "dsh-md-field", key: label },
        React.createElement("label", null, label),
        control,
        hint === undefined ? null : React.createElement("div", { className: "dsh-md-hint" }, hint)
      );
    }

    function checkRow(id, label, checked, onChange, disabled) {
      return React.createElement(
        "div",
        { className: "dsh-md-field is-check", key: id },
        React.createElement("input", {
          id,
          type: "checkbox",
          checked,
          disabled: disabled === true,
          onChange: (event) => onChange(event.target.checked)
        }),
        React.createElement("label", { htmlFor: id }, label)
      );
    }

    /** 一个账号一行：名字、邮箱、状态，右边是编辑/删除。 */
    function AccountRow({ account, selected, onSelect, onRemove }) {
      const [confirm, setConfirm] = React.useState(false);
      const [dropData, setDropData] = React.useState(true);

      return React.createElement(
        "div",
        { className: "dsh-md-acc" },
        React.createElement(
          "div",
          {
            className: selected ? "dsh-md-acc-main is-on" : "dsh-md-acc-main",
            role: "button",
            tabIndex: 0,
            onClick: () => onSelect(account.id),
            onKeyDown: (event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                onSelect(account.id);
              }
            }
          },
          React.createElement(
            "div",
            { className: "dsh-md-row-title" },
            React.createElement("span", null, account.name || account.user),
            account.hasPassword
              ? null
              : React.createElement("span", { className: "dsh-md-badge is-reply" }, "未存授权码")
          ),
          React.createElement(
            "div",
            { className: "dsh-md-row-sub" },
            `${account.user}@${account.host || "（未填服务器）"}:${account.port}`
            + ` · 未整理 ${account.counts.unfiled} / 共 ${account.counts.messages} 封 · ${account.counts.reports} 份报告`
          )
        ),
        React.createElement(
          "div",
          { className: "dsh-md-row-actions" },
          confirm
            ? React.createElement(
                React.Fragment,
                null,
                React.createElement(
                  "label",
                  { className: "dsh-md-hint dsh-md-inline" },
                  React.createElement("input", {
                    type: "checkbox",
                    checked: dropData,
                    onChange: (event) => setDropData(event.target.checked)
                  }),
                  "连数据一起删"
                ),
                React.createElement(
                  "button",
                  {
                    type: "button",
                    className: "dsh-md-btn is-danger",
                    onClick: () => {
                      setConfirm(false);
                      onRemove(account.id, dropData);
                    }
                  },
                  "确认删除"
                ),
                React.createElement(
                  "button",
                  { type: "button", className: "dsh-md-btn is-link", onClick: () => setConfirm(false) },
                  "取消"
                )
              )
            : React.createElement(
                "button",
                { type: "button", className: "dsh-md-btn is-link", onClick: () => setConfirm(true) },
                "删除"
              )
        )
      );
    }

    function ConfigTab({ status, onSaved }) {
      const accounts = status.accounts;
      const [selectedId, setSelectedId] = React.useState(() => (accounts[0] === undefined ? "" : accounts[0].id));
      const selected = accounts.find((account) => account.id === selectedId);
      const [form, setForm] = React.useState(() => accountForm(selected ?? {}));
      const [rows, setRows] = React.useState(() => status.tags.map((tag) => ({ id: tag.id, name: tag.name })));
      const [busy, setBusy] = React.useState(false);
      const [error, setError] = React.useState(null);
      const [ok, setOk] = React.useState(null);
      const [provider, setProvider] = React.useState(() => providerIdOf((selected ?? {}).host));

      const patch = (next) => setForm((current) => ({ ...current, ...next }));

      /** 选中账号时把表单切过去。 */
      const select = (id) => {
        setSelectedId(id);
        const account = accounts.find((item) => item.id === id);
        setForm(accountForm(account ?? {}));
        setProvider(providerIdOf(account?.host));
        setError(null);
        setOk(null);
      };

      /** 选服务商：预设的直接填好主机/端口，选「其他」才让人手填。 */
      const chooseProvider = (id) => {
        setProvider(id);
        const hit = providerById(id);
        if (hit === undefined) return;
        if (hit.id === "other") {
          const currentHost = String(form.host ?? "").trim().toLowerCase();
          const fromPreset = PROVIDERS.some((item) => item.host !== "" && item.host === currentHost);
          patch(fromPreset ? { host: "", port: 993, secure: true } : { port: form.port ?? 993 });
          return;
        }
        patch({ host: hit.host, port: hit.port, secure: hit.secure });
      };

      /** 填了账号但还没选服务商时，按域名猜一个。 */
      const guessProvider = (address) => {
        if (provider !== "") return;
        const guessed = providerIdOfAddress(address);
        if (guessed !== "") {
          setProvider(guessed);
          const hit = providerById(guessed);
          if (hit !== undefined) patch({ host: hit.host, port: hit.port, secure: hit.secure });
        }
      };

      const manualHost = provider === "other" || provider === "";
      const providerHint = providerById(provider)?.hint ?? "";

      const payload = () => {
        const rawPort = String(form.port ?? "").trim();
        const port = rawPort === "" ? (form.secure === true ? 993 : 143) : Number(rawPort);
        return {
          account: {
            id: selectedId,
            host: form.host.trim(),
            port,
            secure: form.secure === true,
            user: form.user.trim(),
            mailbox: form.mailbox.trim() === "" ? "INBOX" : form.mailbox.trim(),
            days: Number(String(form.days === "" ? 30 : form.days)),
            limit: Number(String(form.limit === "" ? 100 : form.limit)),
            fromFilter: form.fromFilter.trim(),
            subjectFilter: form.subjectFilter.trim(),
            unseenOnly: form.unseenOnly === true
          },
          password: form.password === "" ? undefined : form.password
        };
      };

      const runTest = async () => {
        setBusy(true);
        setError(null);
        setOk(null);
        try {
          const value = await call("probe", payload());
          if (value.ok === true) setOk(`连接成功（${value.elapsedMs}ms，邮箱里共 ${value.messageCount ?? "?"} 封）`);
          else setError(value.error || "连接失败");
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure));
        } finally {
          setBusy(false);
        }
      };

      const save = async () => {
        setBusy(true);
        setError(null);
        setOk(null);
        try {
          const body = payload();
          body.tags = rows.map((row) => ({ id: row.id, name: row.name.trim() })).filter((row) => row.name !== "");
          const saved = await call("save", body);
          const createdId = selectedId === "" && saved.accounts.length > 0
            ? saved.accounts[saved.accounts.length - 1].id
            : selectedId;
          setRows(saved.tags.map((tag) => ({ id: tag.id, name: tag.name })));
          setForm((current) => ({ ...current, password: "" }));
          setSelectedId(createdId);
          setProvider(providerIdOf(saved.accounts.find((account) => account.id === createdId)?.host));
          setOk("已保存。");
          bumpRevision();
          await onSaved();
          notify("已保存", true);
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure));
        } finally {
          setBusy(false);
        }
      };

      const addNew = () => {
        setSelectedId("");
        setForm(accountForm({}));
        setProvider("");
        setError(null);
        setOk(null);
      };

      const remove = async (id, deleteData) => {
        setBusy(true);
        setError(null);
        setOk(null);
        try {
          const result = await call("removeAccount", { id, deleteData });
          if (selectedId === id) {
            setSelectedId("");
            setForm(accountForm({}));
            setProvider("");
          }
          setOk(result.messages === 0
            ? "已删除邮箱，数据保留。"
            : `已删除邮箱，连同 ${result.messages} 封邮件、${result.reports} 份报告。`);
          bumpRevision();
          await onSaved();
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure));
        } finally {
          setBusy(false);
        }
      };

      const input = (key, props) => React.createElement("input", {
        value: String(form[key] ?? ""),
        onChange: (event) => patch({ [key]: event.target.value }),
        ...props
      });

      const canSave = missingRequired(form) === false && busy === false;

      return React.createElement(
        "div",
        { className: "dsh-md-section" },
        React.createElement(
          "div",
          { className: "dsh-md-toolbar" },
          React.createElement(
            "span",
            { className: "dsh-md-hint" },
            selectedId === "" ? "新建邮箱" : `正在编辑：${selected?.name || selected?.user || selectedId}`
          ),
          React.createElement(
            "button",
            { type: "button", className: "dsh-md-btn", onClick: addNew, disabled: busy },
            "+ 添加邮箱"
          )
        ),
        accounts.length === 0
          ? null
          : React.createElement(
              "div",
              { className: "dsh-md-list" },
              accounts.map((account) => React.createElement(AccountRow, {
                key: account.id,
                account,
                selected: account.id === selectedId,
                onSelect: select,
                onRemove: remove
              }))
            ),
        React.createElement("h4", null, "IMAP"),
        React.createElement(
          "div",
          { className: "dsh-md-grid" },
          field(
            "邮箱服务商",
            React.createElement(
              "select",
              {
                value: provider,
                "aria-label": "邮箱服务商",
                onChange: (event) => chooseProvider(event.target.value)
              },
              React.createElement("option", { value: "" }, "选择服务商…"),
              PROVIDERS.map((item) => React.createElement("option", { value: item.id, key: item.id }, item.label))
            ),
            providerHint === "" ? undefined : providerHint,
            true
          ),
          field(
            "服务器",
            React.createElement("input", {
              value: String(form.host ?? ""),
              placeholder: "imap.qq.com",
              disabled: !manualHost,
              onChange: (event) => patch({ host: event.target.value })
            }),
            manualHost ? undefined : "自动填写"
          ),
          field(
            "端口",
            React.createElement("input", {
              value: String(form.port ?? ""),
              type: "number",
              min: 1,
              max: 65535,
              placeholder: "993",
              disabled: !manualHost,
              onChange: (event) => patch({ port: event.target.value })
            })
          ),
          checkRow("dsh-md-secure", "SSL/TLS", form.secure === true, (checked) => {
            const currentPort = String(form.port ?? "").trim();
            const autoPort = currentPort === "" || currentPort === "993" || currentPort === "143";
            patch(autoPort ? { secure: checked, port: checked ? 993 : 143 } : { secure: checked });
          }, !manualHost),
          field("账号", React.createElement("input", {
            value: String(form.user ?? ""),
            placeholder: "you@example.com",
            onChange: (event) => {
              patch({ user: event.target.value });
              guessProvider(event.target.value);
            }
          }), undefined, true),
          field(
            "密码 / 授权码",
            input("password", {
              type: "password",
              placeholder: selected?.hasPassword === true ? "已存，留空表示不修改" : "写进 DSH 凭据库"
            }),
            "用邮箱授权码，不是登录密码。",
            true
          ),
          field("回看天数", input("days", { type: "number", min: 0, max: 3650 }), "0 = 不限时间"),
          field("单次最多抓几封", input("limit", { type: "number", min: 1, max: 500 }), "只取最新 N 封"),
          field("发件人包含", input("fromFilter", { placeholder: "留空不筛" })),
          field("主题包含", input("subjectFilter", { placeholder: "留空不筛" })),
          checkRow("dsh-md-unseen", "只看未读", form.unseenOnly === true, (checked) => patch({ unseenOnly: checked }))
        ),
        React.createElement("h4", null, "标签"),
        React.createElement(
          "div",
          { className: "dsh-md-hint" },
          "给模型的起点，可留空。"
        ),
        React.createElement(
          "div",
          { className: "dsh-md-grid is-spaced" },
          rows.map((row, index) => React.createElement(
            "div",
            { className: "dsh-md-tagrow", key: `${row.id}-${index}` },
            React.createElement("input", {
              value: row.name,
              "aria-label": "标签名称",
              placeholder: "标签名，例如 账单/发票",
              onChange: (event) => setRows((current) => current.map((item, at) => (
                at === index ? { ...item, name: event.target.value } : item
              )))
            }),
            React.createElement(
              "button",
              {
                type: "button",
                className: "dsh-md-btn is-link",
                disabled: busy,
                onClick: () => setRows((current) => current.filter((_item, at) => at !== index))
              },
              "删"
            )
          )),
          React.createElement(
            "button",
            {
              type: "button",
              className: "dsh-md-btn is-link",
              disabled: busy,
              onClick: () => setRows((current) => [...current, { id: "", name: "" }])
            },
            "+ 加标签"
          )
        ),
        error !== null ? React.createElement("div", { className: "dsh-md-error", role: "alert" }, error) : null,
        ok !== null ? React.createElement("div", { className: "dsh-md-ok" }, ok) : null,
        React.createElement(
          "div",
          { className: "dsh-md-actions" },
          React.createElement(
            "button",
            { type: "button", className: "dsh-md-btn", disabled: busy, onClick: runTest },
            busy ? "测试中…" : "测试连接"
          ),
          React.createElement("div", { className: "dsh-md-spacer" }),
          React.createElement(
            "button",
            { type: "button", className: "dsh-md-btn is-primary", disabled: !canSave, onClick: save },
            canSave ? "保存" : "先填服务器和账号"
          )
        )
      );
    }

    // ── 邮件列表 ────────────────────────────────────────────────────────────

    // ── 侧边栏报告面板 ──────────────────────────────────────────────────────

    /** dsh-resource://mail-digest-report/<id> → id */
    function reportIdFromAddress(address) {
      const text = String(address ?? "");
      const tail = text.startsWith(REPORT_PREFIX) ? text.slice(REPORT_PREFIX.length) : text;
      return decodeURIComponent(tail.split(/[?#]/)[0] ?? "");
    }

    function PanelSection({ title, extra, children }) {
      return React.createElement(
        "section",
        null,
        React.createElement(
          "div",
          { className: "dsh-md-panel-meta" },
          title,
          extra === undefined ? null : React.createElement("span", { className: "dsh-md-panel-sub" }, `　${extra}`)
        ),
        children
      );
    }

    function ReportBody(props) {
      const useTabInfo = props.useTabInfo;
      const info = typeof useTabInfo === "function" ? useTabInfo() : null;
      const tab = info === null ? null : info.tab;
      const id = tab === null ? "" : reportIdFromAddress(tab.contentId);

      const [state, setState] = React.useState({ status: "loading", content: null, html: "", error: null, stale: false });
      const [busy, setBusy] = React.useState(false);

      React.useEffect(() => {
        if (id === "") return undefined;
        let alive = true;
        setState({ status: "loading", content: null, html: "", error: null, stale: false });
        call("reportContent", { id })
          .then((value) => {
            if (!alive) return;
            setState({ status: "ready", content: value.content, html: typeof value.html === "string" ? value.html : "", error: null, stale: false });
          })
          .catch(async (failure) => {
            // 新接口在旧进程里可能还没注册（typert 清单只在进程启动时读）：
            // 退回已有的 reports/read，把 Markdown 原样显示，并提示重启。
            const message = failure instanceof Error ? failure.message : String(failure);
            try {
              const fallback = await call("reports", { action: "read", id });
              if (!alive) return;
              setState({
                status: "ready",
                content: { id, title: fallback.report.title, focus: [], pending: [], threads: [], tags: [], rest: [], stats: {}, raw: fallback.markdown },
                html: "",
                error: null,
                stale: message.includes("404")
              });
            } catch {
              if (alive) setState({ status: "error", content: null, html: "", error: message, stale: false });
            }
          });
        return () => {
          alive = false;
        };
      }, [id]);

      const openInBrowser = async () => {
        setBusy(true);
        try {
          await call("openInBrowser", { id });
          notify("已用浏览器打开", true);
        } catch (failure) {
          const text = failure instanceof Error ? failure.message : String(failure);
          notify(text.includes("404") ? "需要重启 DSH。" : text, false);
        } finally {
          setBusy(false);
        }
      };

      const close = () => {
        try {
          tab?.actions?.close?.();
        } catch {
          // 关不掉就算了，用户还能点标签上的 ×
        }
      };

      if (tab === null) {
        return React.createElement(
          "div",
          { className: "dsh-md-panel" },
          React.createElement("div", { className: "dsh-md-error", role: "alert" }, "没拿到报告地址，关掉重开。")
        );
      }

      const content = state.content;
      const head = React.createElement(
        "div",
        { className: "dsh-md-panel-head" },
        React.createElement(
          "div",
          { className: "dsh-md-panel-title" },
          content === null ? "邮件整理报告" : content.title
        ),
        React.createElement(
          "div",
          { className: "dsh-md-inline" },
          React.createElement(
            "button",
            {
              type: "button",
              className: "dsh-md-btn is-link",
              onClick: openInBrowser,
              disabled: busy || state.status !== "ready"
            },
            busy ? "打开中…" : "在浏览器打开"
          ),
          React.createElement("button", { type: "button", className: "dsh-md-btn is-link", onClick: close }, "关闭")
        )
      );

      if (state.status === "loading") {
        return React.createElement("div", { className: "dsh-md-panel" }, head,
          React.createElement("div", { className: "dsh-md-empty" }, "读取中…"));
      }
      if (state.status === "error") {
        return React.createElement("div", { className: "dsh-md-panel" }, head,
          React.createElement("div", { className: "dsh-md-error", role: "alert" }, state.error ?? "读不出来"));
      }

      // 有网页版就直接渲染网页（沙箱内联，不带脚本）；没有就退回文字。
      const body = state.html !== ""
        ? React.createElement("iframe", {
            className: "dsh-md-frame",
            title: content?.title ?? "邮件整理报告",
            sandbox: "",
            srcDoc: state.html
          })
        : React.createElement("pre", { className: "dsh-md-text" }, content?.raw ?? "这份报告没有网页版。");

      return React.createElement(
        "div",
        { className: "dsh-md-panel" },
        head,
        state.stale
          ? React.createElement("div", { className: "dsh-md-error", role: "alert" },
              "需要重启 DSH 才能显示网页版，先按文本显示。")
          : null,
        body
      );
    }

    function ReportsTab({ status, account, reload }) {
      const revision = useStore(revisionStore);
      const [state, setState] = React.useState({ reports: [], unread: 0, total: 0 });
      const [error, setError] = React.useState(null);
      const [confirmId, setConfirmId] = React.useState(null);
      const [busy, setBusy] = React.useState(false);
      const [banner, setBanner] = React.useState(null);

      const load = React.useCallback(async () => {
        try {
          const value = await call("reports", {
            action: "list",
            accountId: account === null ? undefined : account.id,
            limit: 100
          });
          setState({ reports: value.reports ?? [], unread: value.unread ?? 0, total: value.total ?? 0 });
          setError(null);
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure));
        }
      }, [account]);

      React.useEffect(() => {
        load();
      }, [load, revision]);

      const runNow = async () => {
        setBusy(true);
        setBanner(null);
        try {
          const value = await call("runNow", {});
          setBanner({ ok: true, text: value.note ?? "已排上，稍后出报告。" });
          notify("已开始整理", true);
          // 整理要跑一会儿：隔几轮自己查一次，报告一出来就弹卡片并刷新列表。
          for (const delay of [5000, 15000, 30000, 60000, 90000]) {
            setTimeout(() => {
              pollUnread();
              load();
              reload();
            }, delay);
          }
        } catch (failure) {
          setBanner({ ok: false, text: failure instanceof Error ? failure.message : String(failure) });
        } finally {
          setBusy(false);
        }
      };

      const remove = async (id) => {
        if (confirmId !== id) {
          setConfirmId(id);
          return;
        }
        setConfirmId(null);
        try {
          const value = await call("reports", { action: "delete", id });
          const restored = typeof value.restored === "number" ? value.restored : 0;
          notify(restored > 0 ? `已删除报告，${restored} 封邮件退回待整理` : "已删除报告", true);
          await load();
          await reload();
        } catch (failure) {
          notify(failure instanceof Error ? failure.message : String(failure), false);
        }
      };

      return React.createElement(
        "div",
        { className: "dsh-md-section" },
        React.createElement(
          "div",
          { className: "dsh-md-head" },
          React.createElement(
            "div",
            { className: "dsh-md-meta" },
            `${account === null ? "" : `${account.name || account.user} · `}`
            + `${state.reports.length < state.total ? `显示最近 ${state.reports.length} / 共 ${state.total} 份` : `共 ${state.total} 份报告`}，未读 ${state.unread} 份`
          ),
          React.createElement(
            "div",
            { className: "dsh-md-head-actions" },
            React.createElement(
              "button",
              { type: "button", className: "dsh-md-btn", onClick: () => load(), disabled: busy },
              "刷新"
            ),
            React.createElement(
              "button",
              {
                type: "button",
                className: "dsh-md-btn is-primary",
                onClick: runNow,
                disabled: busy || status.accounts.length === 0,
                title: status.accounts.length === 0 ? "先在「配置」添加邮箱" : undefined
              },
              busy ? "已排上…" : "立即整理"
            )
          )
        ),
        banner === null
          ? null
          : React.createElement("div", { className: banner.ok ? "dsh-md-ok" : "dsh-md-error", role: "status" }, banner.text),
        error !== null ? React.createElement("div", { className: "dsh-md-error", role: "alert" }, error) : null,
        state.reports.length === 0
          ? React.createElement("div", { className: "dsh-md-empty" },
              status.accounts.length === 0 ? "先到「配置」添加邮箱。" : "还没有报告。",
              React.createElement(
                "div",
                { className: "dsh-md-hint" },
                status.accounts.length === 0
                  ? "点右上角「立即整理」生成第一份。"
                  : "点「立即整理」，或在「自动」里定时。"
              ))
          : React.createElement(
              "div",
              { className: "dsh-md-list" },
              state.reports.map((report) => React.createElement(
                "div",
                { className: "dsh-md-row", key: report.id },
                React.createElement(
                  "div",
                  { className: "dsh-md-row-head" },
                  React.createElement(
                    "div",
                    {
                      className: "dsh-md-row-main",
                      role: "button",
                      tabIndex: 0,
                      onClick: () => openReport(report.id, report.title).then((mode) => {
                        if (mode === "behind") notify("已在该会话右侧打开", true);
                      }).catch(() => {}),
                      onKeyDown: (event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          openReport(report.id, report.title).then((mode) => {
                            if (mode === "behind") notify("已在该会话右侧打开", true);
                          }).catch(() => {});
                        }
                      }
                    },
                    React.createElement(
                      "div",
                      { className: "dsh-md-row-title" },
                      report.unread ? React.createElement("span", { className: "dsh-md-badge is-new" }, "未读") : null,
                      React.createElement("span", null, report.title)
                    ),
                    React.createElement(
                      "div",
                      { className: "dsh-md-row-sub" },
                      `${stamp(report.createdAt)} · ${report.messages} 封 / ${report.threads} 条线程${report.summary === "" ? "" : ` · ${report.summary}`}`
                    )
                  ),
                  React.createElement(
                    "div",
                    { className: "dsh-md-row-actions" },
                    report.auto ? React.createElement("span", { className: "dsh-md-badge is-tag" }, "自动") : null,
                    React.createElement(
                      "button",
                      {
                        type: "button",
                        className: confirmId === report.id ? "dsh-md-btn is-danger" : "dsh-md-btn is-link",
                        onClick: () => remove(report.id),
                        onBlur: () => setConfirmId(null)
                      },
                      confirmId === report.id ? "确认删除？" : "删除"
                    )
                  )
                )
              ))
            ),
        React.createElement("div", { className: "dsh-md-foot" }, "删除后这批邮件退回待整理，下次整理会重新出报告。")
      );
    }

    function AutoTab({ status, reload }) {
      const [enabled, setEnabled] = React.useState(status.auto.enabled === true);
      const [mode, setMode] = React.useState(status.auto.mode === "daily" ? "daily" : "every");
      const [hours, setHours] = React.useState(Math.max(1, Math.round((status.auto.everySeconds ?? 21600) / 3600)));
      const [at, setAt] = React.useState(typeof status.auto.at === "string" ? status.auto.at : "09:00");
      const [busy, setBusy] = React.useState(false);
      const [message, setMessage] = React.useState(null);

      React.useEffect(() => {
        setEnabled(status.auto.enabled === true);
        setMode(status.auto.mode === "daily" ? "daily" : "every");
        setHours(Math.max(1, Math.round((status.auto.everySeconds ?? 21600) / 3600)));
        setAt(typeof status.auto.at === "string" ? status.auto.at : "09:00");
      }, [status.auto.enabled, status.auto.mode, status.auto.everySeconds, status.auto.at]);

      const save = async () => {
        setBusy(true);
        setMessage(null);
        try {
          const value = await call("auto", { enabled, mode, everySeconds: hours * 3600, at });
          if (value.error !== "") {
            setMessage({ ok: false, text: value.error });
          } else {
            setMessage({ ok: true, text: enabled ? "已保存。" : "已关闭，计划任务已删除。" });
          }
          await reload();
        } catch (failure) {
          setMessage({ ok: false, text: failure instanceof Error ? failure.message : String(failure) });
        } finally {
          setBusy(false);
        }
      };

      const hourOptions = HOURS.includes(hours) ? HOURS : [...HOURS, hours].sort((a, b) => a - b);
      const scheduleText = status.auto.enabled
        ? (status.auto.mode === "daily" ? `每天 ${status.auto.at}` : `每 ${Math.round(status.auto.everySeconds / 3600)} 小时`)
        : "关着";

      return React.createElement(
        "div",
        { className: "dsh-md-section" },
        React.createElement(
          "div",
          { className: "dsh-md-inline" },
          React.createElement(
            "label",
            { className: "dsh-md-inline" },
            React.createElement("input", {
              type: "checkbox",
              checked: enabled,
              onChange: (event) => setEnabled(event.target.checked)
            }),
            "开启自动整理"
          ),
          React.createElement(
            "select",
            {
              value: mode,
              "aria-label": "频率",
              onChange: (event) => setMode(event.target.value)
            },
            React.createElement("option", { value: "every" }, "每隔"),
            React.createElement("option", { value: "daily" }, "每天")
          ),
          mode === "daily"
            ? React.createElement("input", {
                type: "time",
                value: at,
                "aria-label": "时间",
                onChange: (event) => setAt(event.target.value)
              })
            : React.createElement(
                React.Fragment,
                null,
                React.createElement(
                  "select",
                  {
                    value: String(hours),
                    "aria-label": "间隔小时",
                    onChange: (event) => setHours(Number(event.target.value))
                  },
                  hourOptions.map((value) => React.createElement("option", { value: String(value), key: value }, `${value} 小时`))
                ),
                React.createElement("span", { className: "dsh-md-hint" }, "一次")
              ),
          React.createElement(
            "button",
            { type: "button", className: "dsh-md-btn is-primary", disabled: busy, onClick: save },
            busy ? "保存中…" : "保存设置"
          )
        ),
        message !== null
          ? React.createElement("div", { className: message.ok ? "dsh-md-ok" : "dsh-md-error", role: "status" }, message.text)
          : null,
        status.auto.lastError !== ""
          ? React.createElement("div", { className: "dsh-md-error", role: "alert" }, status.auto.lastError)
          : null,
        React.createElement(
          "div",
          { className: "dsh-md-meta" },
          `状态：${scheduleText}${status.auto.lastRunAt === "" ? "" : ` · 上次生成报告 ${stamp(status.auto.lastRunAt)}`}`
        )
      );
    }

    function Section() {
      const revision = useStore(revisionStore);
      const [status, setStatus] = React.useState(null);
      const [error, setError] = React.useState(null);
      const [tab, setTab] = React.useState("reports");
      const [accountId, setAccountId] = React.useState("");

      const load = React.useCallback(async () => {
        try {
          const value = await call("status");
          setStatus(value);
          setError(null);
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure));
        }
      }, []);

      React.useEffect(() => {
        load();
      }, [load, revision]);

      React.useEffect(() => {
        panelStore.set({ open: true });
        return () => panelStore.set({ open: false });
      }, []);

      React.useEffect(() => {
        pollUnread();
        const timer = setInterval(() => pollUnread(), 10000);
        return () => clearInterval(timer);
      }, []);

      if (status === null) {
        return React.createElement(
          "div",
          { className: "dsh-md-section" },
          React.createElement("div", { className: "dsh-md-head" }, React.createElement("h3", null, "邮件整理")),
          error === null
            ? React.createElement("div", { className: "dsh-md-empty" }, "读取中…")
            : React.createElement(
                "div",
                { className: "dsh-md-error", role: "alert" },
                error,
                React.createElement("div", { className: "dsh-md-inline is-spaced" },
                  React.createElement("button", { type: "button", className: "dsh-md-btn", onClick: () => load() }, "重试"))
              )
        );
      }

      // 选中的账号可能被删掉：退回第一个。
      const accounts = status.accounts;
      const account = accounts.find((item) => item.id === accountId)
        ?? (accounts.length > 0 ? accounts[0] : null);

      const tabs = [
        { id: "reports", label: `报告${status.counts.unreadReports > 0 ? `（${status.counts.unreadReports}）` : ""}` },
        { id: "auto", label: "自动" },
        { id: "config", label: "配置" }
      ];

      const showSwitcher = tab === "reports" && accounts.length > 1;
      const switcher = showSwitcher
        ? React.createElement(
            "div",
            { className: "dsh-md-chips" },
            accounts.map((item) => React.createElement(
              "button",
              {
                type: "button",
                key: item.id,
                className: account !== null && item.id === account.id ? "dsh-md-chip is-on" : "dsh-md-chip",
                title: `${item.user}@${item.host}`,
                onClick: () => setAccountId(item.id)
              },
              `${item.name || item.user} ${item.counts.unfiled > 0 ? item.counts.unfiled : ""}`.trim()
            ))
          )
        : null;

      return React.createElement(
        "div",
        { className: "dsh-md-section" },
        React.createElement(
          "div",
          { className: "dsh-md-head" },
          React.createElement("h3", null, "邮件整理")
        ),
        React.createElement(
          "div",
          { className: "dsh-md-tabs", role: "tablist" },
          tabs.map((item) => React.createElement(
            "button",
            {
              type: "button",
              role: "tab",
              key: item.id,
              "aria-selected": tab === item.id,
              className: tab === item.id ? "dsh-md-tab is-on" : "dsh-md-tab",
              onClick: () => setTab(item.id)
            },
            item.label
          ))
        ),
        switcher,
        tab === "reports" ? React.createElement(ReportsTab, { status, account, reload: load }) : null,
        tab === "auto" ? React.createElement(AutoTab, { status, reload: load }) : null,
        tab === "config" ? React.createElement(ConfigTab, { status, onSaved: load }) : null,
        React.createElement(NoticeOverlay, { insidePanel: true }),
        React.createElement(ReportOverlay, { insidePanel: true })
      );
    }

    // ── 未读轮询 ────────────────────────────────────────────────────────────

    // 已提示过的报告 id：点过、关过、看完的都不再弹。
    const seenReportIds = new Set();
    let lastNewestId = null;

    /** 系统通知（Electron 里就是 macOS 横幅）；拿不到权限就安静跳过。 */
    function systemNotify(notice) {
      try {
        if (typeof Notification === "undefined") return;
        if (Notification.permission !== "granted") {
          // 有些环境需要显式申请；失败就算了，页内卡片仍在。
          Notification.requestPermission?.();
          return;
        }
        const toast = new Notification("邮件整理 · 新报告", {
          body: notice.summary === "" ? notice.title : `${notice.title}\n${notice.summary}`,
          tag: notice.id
        });
        toast.onclick = () => {
          openReport(notice.id, notice.title);
          toast.close();
        };
      } catch {
        // 系统通知不可用不影响页内卡片
      }
    }

    /**
     * 查一次报告。
     * 不看「未读」这一个信号：报告可能在别的窗口被点开过（未读被清掉），
     * 所以以「最新报告的 id 变了」为准，首次加载时只认 10 分钟内新生成的未读报告。
     */
    async function pollUnread() {
      try {
        const value = await call("reports", { action: "list", limit: 5 });
        const reports = Array.isArray(value.reports) ? value.reports : [];
        const newest = reports[0] ?? null;
        const current = uiStore.get();
        let notice = current.notice;

        if (newest !== null) {
          const isNewer = lastNewestId !== null && newest.id !== lastNewestId;
          const justBorn = lastNewestId === null
            && newest.unread === true
            && Date.now() - new Date(newest.createdAt).getTime() < 10 * 60 * 1000;
          const shouldNotice = (isNewer || justBorn)
            && !seenReportIds.has(newest.id)
            && (notice === null || notice.id !== newest.id)
            && current.report === null;
          if (shouldNotice) {
            notice = newest;
            systemNotify(newest);
          }
          lastNewestId = newest.id;
        }

        const unread = typeof value.unread === "number" ? value.unread : current.unread;
        const changed = unread !== current.unread;
        uiStore.set({ ...current, unread, notice });
        if (changed) bumpRevision();
      } catch {
        // 服务没就绪（Host 还在加载）就等下一轮
      }
    }

    /** 设置页左侧导航里的图标（邮件整理）。 */
    function MailGlyph(props) {
      const size = props !== null && typeof props === "object" && typeof props.size === "number" ? props.size : 16;
      return React.createElement(
        "svg",
        { width: size, height: size, viewBox: "0 0 16 16", fill: "none", "aria-hidden": "true", focusable: "false" },
        React.createElement("path", {
          d: "M2.3 4.4h11.4v7.2H2.3zM2.3 4.9l5.7 4.1 5.7-4.1",
          stroke: "currentColor",
          strokeWidth: 1.4,
          strokeLinecap: "round",
          strokeLinejoin: "round"
        })
      );
    }

    function apply(ctx) {
      ctxRef = ctx;
      mountReady = ctx.remote.$mount(REMOTE).catch((error) => {
        mountError = error;
      });
      const slots = ctx.get("slots");
      if (slots === undefined) return;

      ctx.effect(() => ensureStyle());
      slots.inject("settings.section", () =>
        slots.register({ name: "settings.section", id: "mail-digest", order: 44, label: () => "邮件整理" }, Section)
      );

      // 设置页左侧导航的图标：不注册就是壳默认的齿轮。
      slots.inject("settings.section.icon", () =>
        slots.register({ name: "settings.section.icon", id: "mail-digest", order: 44 }, MailGlyph)
      );
      // 侧边栏的报告面板：类型 + 面板体。
      // 记住最近一次前台的会话：设置页里点报告时，用这个 id 把面板挂上去。
      const sidebarNav = ctx.get("sidebarRight");
      const mounted = sidebarNav === null || sidebarNav === undefined ? undefined : sidebarNav.mounted;
      if (mounted !== undefined && mounted !== null) {
        const remember = (value) => {
          if (typeof value === "string" && value !== "") lastSessionId = value;
        };
        try {
          if (typeof mounted.get === "function") remember(mounted.get());
          if (typeof mounted.subscribe === "function") {
            const dispose = mounted.subscribe(remember);
            ctx.effect(() => () => {
              try {
                dispose?.();
              } catch {
                // 取消订阅失败不影响别的
              }
            });
          }
        } catch {
          // 拿不到就不记，点报告时会退回浏览器
        }
      }

      const reportTabs = ctx.get("sidebarRightTabs");
      if (reportTabs !== undefined && reportTabs !== null) ctx.effect(() => reportTabs.register({
        id: REPORT_TYPE_ID,
        kind: REPORT_KIND,
        multiple: true,
        priority: "extension",
        patterns: [`${REPORT_PREFIX}**`],
        title: () => "邮件整理报告"
      }));
      ctx.effect(() => ctx.slots.inject("sidebar.right.pane.tab", () =>
        ctx.slots.register({ name: "sidebar.right.pane.tab", key: REPORT_TYPE_ID }, ReportBody)
      ));

      slots.inject("shell.overlay", () =>
        slots.register({ name: "shell.overlay", id: "mail-digest.notice" }, function MailDigestOverlay() {
          return React.createElement(React.Fragment, null,
            React.createElement(NoticeOverlay, { insidePanel: false }),
            React.createElement(ReportOverlay, { insidePanel: false }));
        })
      );

      // 20 秒一轮；页面重新可见 / 窗口获得焦点时也立刻查一次（自动整理常在后台跑完）。
      ctx.effect(() => {
        const timer = setInterval(() => {
          if (typeof document !== "undefined" && document.hidden === true) return;
          pollUnread();
        }, 20000);
        const onVisible = () => {
          if (typeof document !== "undefined" && document.hidden !== true) pollUnread();
        };
        document.addEventListener("visibilitychange", onVisible);
        window.addEventListener("focus", onVisible);
        pollUnread();
        return () => {
          clearInterval(timer);
          document.removeEventListener("visibilitychange", onVisible);
          window.removeEventListener("focus", onVisible);
        };
      });
    }

    exports.apply = apply;
    exports.inject = ["slots", "remote"];
    return module.exports;
  }
});
