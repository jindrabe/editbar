/*!
 * Editbar widget — drop-in inline text editor bar.
 * Usage: <script src=".../widget.js" data-api="https://your-editbar-server.example.com" defer></script>
 * Mark any text you want editable with: <span data-edit-id="hero.title">Welcome</span>
 */
(function () {
  "use strict";

  var scriptEl =
    document.currentScript ||
    document.querySelector('script[src*="widget.js"]');

  var apiBase = resolveApiBase(scriptEl);
  var tokenStorageKey = "editbar_token";
  var draftsStorageKey = "editbar_drafts:" + location.host;

  var state = {
    published: {},
    drafts: loadDrafts(),
    editing: false,
    token: loadToken(),
    originals: new Map(), // edit-id -> text present in the DOM before any override
  };

  var els = {}; // filled in by createBar()

  function resolveApiBase(el) {
    if (el && el.getAttribute("data-api")) {
      return el.getAttribute("data-api").replace(/\/$/, "");
    }
    if (el && el.src) {
      try {
        return new URL(el.src, location.href).origin;
      } catch (e) {
        /* fall through */
      }
    }
    return location.origin;
  }

  function loadToken() {
    var fromUrl = new URLSearchParams(location.search).get("edit_token");
    if (fromUrl) {
      try {
        localStorage.setItem(tokenStorageKey, fromUrl);
      } catch (e) {}
      var url = new URL(location.href);
      url.searchParams.delete("edit_token");
      history.replaceState({}, "", url.toString());
      return fromUrl;
    }
    try {
      return localStorage.getItem(tokenStorageKey) || "";
    } catch (e) {
      return "";
    }
  }

  function loadDrafts() {
    try {
      var raw = localStorage.getItem(draftsStorageKey);
      return raw ? JSON.parse(raw) : {};
    } catch (e) {
      return {};
    }
  }

  function saveDrafts() {
    try {
      localStorage.setItem(draftsStorageKey, JSON.stringify(state.drafts));
    } catch (e) {}
  }

  function clearDrafts() {
    state.drafts = {};
    try {
      localStorage.removeItem(draftsStorageKey);
    } catch (e) {}
  }

  function editableElements() {
    return Array.prototype.slice.call(
      document.querySelectorAll("[data-edit-id]")
    );
  }

  function committedValue(key, el) {
    if (Object.prototype.hasOwnProperty.call(state.published, key)) {
      return state.published[key];
    }
    return state.originals.get(key) ?? (el ? el.textContent : "");
  }

  function applyText(el, key, text) {
    if (el.textContent !== text) el.textContent = text;
  }

  function applyPublishedAndDrafts() {
    editableElements().forEach(function (el) {
      var key = el.getAttribute("data-edit-id");
      if (!state.originals.has(key)) {
        state.originals.set(key, el.textContent);
      }
      var value = Object.prototype.hasOwnProperty.call(state.drafts, key)
        ? state.drafts[key]
        : committedValue(key, el);
      applyText(el, key, value);
    });
  }

  function fetchPublished() {
    return fetch(apiBase + "/overrides.json", { credentials: "omit" })
      .then(function (res) {
        if (!res.ok) throw new Error("failed to load overrides");
        return res.json();
      })
      .then(function (data) {
        state.published = data || {};
      })
      .catch(function () {
        state.published = state.published || {};
      });
  }

  // ---- Edit-mode DOM behavior ------------------------------------------

  var HOVER_OUTLINE = "2px solid #0a84ff";
  var ACTIVE_OUTLINE = "2px solid #ff9f0a";

  function isActive(el) {
    return el.getAttribute("contenteditable") === "true";
  }

  function onMouseOver(e) {
    if (!state.editing) return;
    var el = e.target.closest("[data-edit-id]");
    if (el && !isActive(el)) {
      el.style.outline = HOVER_OUTLINE;
      el.style.outlineOffset = "2px";
      el.style.cursor = "text";
    }
  }

  function onMouseOut(e) {
    var el = e.target.closest("[data-edit-id]");
    if (el && !isActive(el)) {
      el.style.outline = "";
      el.style.outlineOffset = "";
      el.style.cursor = "";
    }
  }

  function onClickCapture(e) {
    if (!state.editing) return;
    var el = e.target.closest("[data-edit-id]");
    if (!el) return;
    e.preventDefault();
    e.stopPropagation();
    if (isActive(el)) return;
    el.setAttribute("contenteditable", "true");
    el.style.outline = ACTIVE_OUTLINE;
    el.style.outlineOffset = "2px";
    el.style.cursor = "text";
    el.focus();
  }

  function onBlurCapture(e) {
    var el = e.target.closest && e.target.closest("[data-edit-id]");
    if (!el || !isActive(el)) return;
    commitDraft(el);
    el.setAttribute("contenteditable", "false");
    el.style.outline = "";
    el.style.outlineOffset = "";
    el.style.cursor = "";
  }

  function commitDraft(el) {
    var key = el.getAttribute("data-edit-id");
    var text = el.textContent;
    var base = committedValue(key, el);
    if (text === base) {
      delete state.drafts[key];
    } else {
      state.drafts[key] = text;
    }
    saveDrafts();
    renderBarState();
  }

  function lockAllEditableNow() {
    editableElements().forEach(function (el) {
      if (isActive(el)) {
        commitDraft(el);
        el.setAttribute("contenteditable", "false");
        el.style.outline = "";
        el.style.outlineOffset = "";
        el.style.cursor = "";
      }
    });
  }

  function setEditing(next) {
    state.editing = next;
    if (!next) lockAllEditableNow();
    document.documentElement.toggleAttribute("data-editbar-editing", next);
    renderBarState();
  }

  function discardDrafts() {
    var keys = Object.keys(state.drafts);
    clearDrafts();
    editableElements().forEach(function (el) {
      var key = el.getAttribute("data-edit-id");
      if (keys.indexOf(key) !== -1) {
        applyText(el, key, committedValue(key, el));
      }
    });
    renderBarState();
  }

  function saveChanges() {
    var changes = state.drafts;
    if (Object.keys(changes).length === 0) return;
    setStatus("Saving…", null);
    fetch(apiBase + "/overrides", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + state.token,
      },
      body: JSON.stringify({ changes: changes }),
    })
      .then(function (res) {
        if (res.status === 401) throw new Error("unauthorized");
        if (!res.ok) throw new Error("save failed");
        return res.json();
      })
      .then(function (data) {
        state.published = data || state.published;
        clearDrafts();
        setStatus("Saved", "ok");
        renderBarState();
      })
      .catch(function (err) {
        var msg =
          err.message === "unauthorized"
            ? "Invalid token"
            : "Could not save changes";
        setStatus(msg, "error");
      });
  }

  function signOut() {
    try {
      localStorage.removeItem(tokenStorageKey);
    } catch (e) {}
    setEditing(false);
    removeBar();
  }

  // ---- Bar UI (Shadow DOM) ----------------------------------------------

  var STYLE = `
    :host { all: initial; }
    @keyframes editbar-in {
      from { opacity: 0; transform: translateY(6px) scale(0.96); }
      to   { opacity: 1; transform: translateY(0) scale(1); }
    }
    .bar {
      position: fixed;
      left: 16px;
      bottom: 16px;
      z-index: 2147483647;
      display: flex;
      align-items: center;
      gap: 2px;
      padding: 5px;
      border-radius: 22px;
      font-family: -apple-system, BlinkMacSystemFont, "Inter", "SF Pro Text", system-ui, sans-serif;
      font-size: 13px;
      color: #1c1c1e;
      background: rgba(255, 255, 255, 0.5);
      backdrop-filter: blur(28px) saturate(1.9);
      -webkit-backdrop-filter: blur(28px) saturate(1.9);
      box-shadow:
        0 0 0 0.5px rgba(0,0,0,0.05),
        inset 0 1px 0 rgba(255,255,255,0.7),
        inset 0 0 0 1px rgba(255,255,255,0.15),
        0 2px 6px rgba(0,0,0,0.06),
        0 12px 32px rgba(0,0,0,0.16);
      animation: editbar-in 0.35s cubic-bezier(0.16, 1, 0.3, 1);
      transition: box-shadow 0.2s ease, background 0.2s ease;
    }
    @media (prefers-color-scheme: dark) {
      .bar {
        color: #f2f2f7;
        background: rgba(30, 30, 32, 0.5);
        box-shadow:
          0 0 0 0.5px rgba(0,0,0,0.3),
          inset 0 1px 0 rgba(255,255,255,0.12),
          inset 0 0 0 1px rgba(255,255,255,0.06),
          0 2px 6px rgba(0,0,0,0.3),
          0 12px 32px rgba(0,0,0,0.45);
      }
    }
    .group {
      display: flex;
      align-items: center;
      gap: 2px;
      padding: 0 2px;
    }
    .divider {
      width: 1px;
      height: 20px;
      flex: none;
      background: rgba(0,0,0,0.08);
      margin: 0 2px;
    }
    @media (prefers-color-scheme: dark) {
      .divider { background: rgba(255,255,255,0.12); }
    }
    .dot {
      width: 8px; height: 8px; border-radius: 50%;
      background: #34c759;
      flex: none;
      margin: 0 2px 0 6px;
      box-shadow: 0 0 0 2px rgba(52,199,89,0.15);
      transition: background 0.15s ease, box-shadow 0.15s ease;
    }
    .dot.editing {
      background: #ff9f0a;
      box-shadow: 0 0 0 2px rgba(255,159,10,0.18);
    }
    button {
      appearance: none;
      border: none;
      background: transparent;
      font: inherit;
      color: inherit;
      padding: 7px 12px;
      border-radius: 16px;
      cursor: pointer;
      transition: background 0.15s ease, transform 0.1s ease, opacity 0.15s ease;
      white-space: nowrap;
    }
    button:hover { background: rgba(0,0,0,0.06); }
    @media (prefers-color-scheme: dark) {
      button:hover { background: rgba(255,255,255,0.12); }
    }
    button:active { transform: scale(0.96); }
    button.primary {
      background: #0a84ff;
      color: #fff;
      font-weight: 600;
      box-shadow: inset 0 1px 0 rgba(255,255,255,0.35), 0 1px 2px rgba(10,132,255,0.4);
    }
    button.primary:hover { background: #0074e0; }
    button.primary:disabled {
      opacity: 0.35;
      cursor: default;
      transform: none;
      box-shadow: none;
    }
    button.primary:disabled:hover { background: #0a84ff; }
    button.icon {
      padding: 7px 9px;
      font-size: 14px;
      line-height: 1;
      opacity: 0.6;
      margin-right: 2px;
    }
    button.icon:hover { opacity: 1; }
    .status {
      padding: 0 8px;
      opacity: 0.7;
      font-size: 12px;
      max-width: 160px;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .status.error { color: #ff3b30; opacity: 1; }
    .status.ok { color: #34c759; opacity: 1; }
  `;

  function h(tag, attrs, text) {
    var el = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        el.setAttribute(k, attrs[k]);
      });
    }
    if (text != null) el.textContent = text;
    return el;
  }

  function createBar() {
    var host = document.createElement("div");
    host.id = "editbar-host";
    var shadow = host.attachShadow({ mode: "open" });

    var style = document.createElement("style");
    style.textContent = STYLE;
    shadow.appendChild(style);

    var bar = h("div", { class: "bar" });
    var dot = h("span", { class: "dot" });
    var editBtn = h("button", {}, "Edit");
    var saveBtn = h("button", { class: "primary" }, "Save changes");
    var discardBtn = h("button", {}, "Discard");
    var status = h("span", { class: "status" });
    var signOutBtn = h("button", { class: "icon", title: "Exit admin mode" }, "✕");

    editBtn.addEventListener("click", function () {
      setEditing(!state.editing);
    });
    saveBtn.addEventListener("click", saveChanges);
    discardBtn.addEventListener("click", discardDrafts);
    signOutBtn.addEventListener("click", signOut);

    var groupLeft = h("div", { class: "group" });
    groupLeft.appendChild(dot);
    groupLeft.appendChild(editBtn);

    var groupRight = h("div", { class: "group" });
    groupRight.appendChild(saveBtn);
    groupRight.appendChild(discardBtn);
    groupRight.appendChild(status);

    bar.appendChild(groupLeft);
    bar.appendChild(h("div", { class: "divider" }));
    bar.appendChild(groupRight);
    bar.appendChild(h("div", { class: "divider" }));
    bar.appendChild(signOutBtn);
    shadow.appendChild(bar);
    document.body.appendChild(host);

    els = { host, dot, editBtn, saveBtn, discardBtn, status };
    renderBarState();
  }

  function removeBar() {
    if (els.host) els.host.remove();
    els = {};
  }

  function setStatus(text, kind) {
    if (!els.status) return;
    els.status.textContent = text || "";
    els.status.className = "status" + (kind ? " " + kind : "");
    if (kind === "ok") {
      setTimeout(function () {
        if (els.status) {
          els.status.textContent = "";
          els.status.className = "status";
        }
      }, 2000);
    }
  }

  function renderBarState() {
    if (!els.editBtn) return;
    var draftCount = Object.keys(state.drafts).length;
    els.editBtn.textContent = state.editing ? "Done editing" : "Edit";
    els.dot.classList.toggle("editing", state.editing);
    els.saveBtn.disabled = draftCount === 0;
    els.saveBtn.textContent =
      draftCount > 0 ? "Save changes (" + draftCount + ")" : "Save changes";
    els.discardBtn.style.display = draftCount > 0 ? "" : "none";
  }

  // ---- Boot ---------------------------------------------------------------

  function boot() {
    document.addEventListener("mouseover", onMouseOver, true);
    document.addEventListener("mouseout", onMouseOut, true);
    document.addEventListener("click", onClickCapture, true);
    document.addEventListener(
      "blur",
      function (e) {
        onBlurCapture(e);
      },
      true
    );

    fetchPublished().then(function () {
      applyPublishedAndDrafts();
      if (state.token) createBar();
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
