"use strict";
/* Share dialog: creates a signed link, copies it (works on plain-HTTP LAN), shows a QR code. No CDN. */
(function () {
  function toast(msg) {
    let t = document.getElementById("toast");
    if (!t) {
      t = document.createElement("div");
      t.id = "toast";
      t.setAttribute("role", "status");
      t.style.cssText = "position:fixed;left:50%;bottom:24px;transform:translateX(-50%);background:#222;color:#fff;padding:10px 16px;border-radius:8px;z-index:9999;opacity:0;transition:opacity .2s;pointer-events:none";
      document.body.appendChild(t);
    }
    t.textContent = msg;
    t.style.opacity = "1";
    clearTimeout(t._h);
    t._h = setTimeout(() => { t.style.opacity = "0"; }, 2000);
  }

  /** Clipboard with fallbacks: navigator.clipboard (https/localhost only) -> execCommand -> caller shows a selectable box. */
  async function copyText(text, fallbackInput) {
    if (navigator.clipboard && window.isSecureContext) {
      try { await navigator.clipboard.writeText(text); return true; } catch (e) { /* fall through */ }
    }
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.cssText = "position:fixed;top:0;left:0;width:1px;height:1px;opacity:0";
    document.body.appendChild(ta);
    ta.focus(); ta.select(); ta.setSelectionRange(0, text.length);
    let ok = false;
    try { ok = document.execCommand("copy"); } catch (e) { ok = false; }
    ta.remove();
    if (!ok && fallbackInput) { fallbackInput.focus(); fallbackInput.select(); }
    return ok;
  }

  function qrSvg(text) {
    const qr = qrcode(0, "M");
    qr.addData(text);
    qr.make();
    return qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
  }

  let dlg = null;
  function build() {
    dlg = document.createElement("dialog");
    dlg.id = "shareDlg";
    dlg.innerHTML =
      '<style>#shareDlg{background:var(--bg,#14161a);color:var(--fg,#e8eaed);border:1px solid var(--line,#2a2e36);border-radius:10px;width:min(460px,94vw);padding:16px}' +
      '#shareDlg::backdrop{background:rgba(0,0,0,.6)}#shareDlg .r{display:flex;gap:8px;flex-wrap:wrap;margin:8px 0;align-items:center}' +
      '#shareDlg input[type=text]{flex:1;min-width:0}#shareDlg button,#shareDlg select,#shareDlg input{font:inherit;color:inherit;background:transparent;border:1px solid var(--line,#2a2e36);border-radius:6px;padding:6px 10px}' +
      '#shareDlg button{cursor:pointer}#shareDlg #qr{width:170px;height:170px;background:#fff;padding:4px;border-radius:6px}#shareDlg #qr svg{width:100%;height:100%}#shareDlg .m{color:var(--muted,#8b93a1);font-size:13px}</style>' +
      '<h3 id="shTitle" style="margin:0 0 8px;word-break:break-all"></h3>' +
      '<div class="r"><label>Expires <select id="shExp"><option value="1h">1 hour</option><option value="24h" selected>24 hours</option><option value="7d">7 days</option><option value="never">Never</option></select></label>' +
      '<label><input type="checkbox" id="shDl"> Download only</label></div>' +
      '<div class="r"><input type="text" id="shUrl" readonly aria-label="Share link"></div>' +
      '<div class="r"><button id="shCopy">Copy link</button><button id="shLan">Copy LAN link</button><button id="shOnline">Copy online link</button><button id="shVlc">Open in VLC</button></div>' +
      '<div class="m" id="shVlcBox" hidden></div>' +
      '<div class="r"><div id="qr"></div><div class="m" id="shNote">Scan with a phone on the same network.</div></div>' +
      '<div class="r" style="justify-content:flex-end"><button id="shClose">Close</button></div>';
    document.body.appendChild(dlg);
    dlg.querySelector("#shClose").onclick = () => dlg.close();
  }

  async function open(ctx) {
    if (!dlg) build();
    const $ = (id) => dlg.querySelector("#" + id);
    let link = null;
    $("shTitle").textContent = (ctx.isDir ? "Share folder: " : "Share: ") + ctx.name;
    $("shVlcBox").hidden = true;
    $("shDl").checked = false; $("shExp").value = "24h";

    const urlFor = (kind) => {
      if (!link) return "";
      if (kind === "online") return link.online || "";
      if (kind === "lan") return link.lan[0] || "";
      // "Copy link": use the address this page was opened with, unless that is localhost (useless to other devices)
      const local = ["localhost", "127.0.0.1", "[::1]"].includes(location.hostname);
      return local ? (link.lan[0] || location.origin + link.path) : location.origin + link.path;
    };
    function show(kind) {
      const u = urlFor(kind || "main");
      $("shUrl").value = u;
      $("qr").innerHTML = u ? qrSvg(u) : "";
      $("shOnline").disabled = !link || !link.online;
      $("shOnline").title = link && link.online ? "" : "Online mode is not running";
      $("shLan").disabled = !link || !link.lan.length;
    }
    async function create() {
      $("shUrl").value = "Creating link…";
      const r = await fetch("/api/share", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lib: ctx.lib, path: ctx.path, expiry: $("shExp").value, mode: $("shDl").checked ? "download" : "stream" }),
      });
      if (!r.ok) { $("shUrl").value = ""; toast("Could not create link"); return; }
      link = await r.json();
      show("main");
    }
    async function copy(kind) {
      const u = urlFor(kind);
      if (!u) return;
      show(kind);
      const ok = await copyText(u, $("shUrl"));
      toast(ok ? "Link copied" : "Press Ctrl+C to copy the selected link");
    }
    $("shExp").onchange = create;
    $("shDl").onchange = create;
    $("shCopy").onclick = () => copy("main");
    $("shLan").onclick = () => copy("lan");
    $("shOnline").onclick = () => copy("online");
    $("shVlc").onclick = () => {
      const base = urlFor("lan") || urlFor("main");
      const box = $("shVlcBox");
      box.hidden = false;
      box.textContent = "";
      const raw = base + "/raw";
      const a = document.createElement("div");
      a.textContent = "In VLC: Media → Open Network Stream, paste:";
      const input = document.createElement("input");
      input.type = "text"; input.readOnly = true; input.value = raw; input.style.width = "100%";
      box.append(a, input);
      copyText(raw, input).then((ok) => { toast(ok ? "Link copied" : "Press Ctrl+C to copy the selected link"); });
      if (ctx.isDir) a.textContent = "Folder links are browse pages; share a single file for VLC.";
    };
    dlg.showModal();
    await create();
  }

  window.StreamShare = { open, copyText, toast, qrSvg };
})();
