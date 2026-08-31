/*!
 * Editbar widget — drop-in inline text editor bar.
 * Usage: <script src=".../widget.js" data-api="https://your-editbar-server.example.com" defer></script>
 * Mark any text you want editable with: <span data-edit-id="hero.title">Welcome</span>
 */
(function () {
  "use strict";

  // Best-effort: an ?edit_token= link is meant to be opened once, but the
  // token still sits in the URL for every request already in flight when
  // this (deferred) script starts running — e.g. analytics/ad beacons
  // queued earlier in <head>. Their Referer would otherwise carry it to a
  // third-party origin. This can't undo requests already sent, but it
  // limits exposure for everything from this point on.
  if (/[?&]edit_token=/.test(location.search)) {
    var noReferrerMeta = document.createElement("meta");
    noReferrerMeta.name = "referrer";
    noReferrerMeta.content = "no-referrer";
    document.head.insertBefore(noReferrerMeta, document.head.firstChild);
  }

  var scriptEl =
    document.currentScript ||
    document.querySelector('script[src*="widget.js"]');

  var apiBase = resolveApiBase(scriptEl);
  // Scoped per apiBase (not just per host, like drafts/collapsed below) —
  // a page embedding two different Editbar backends (different data-api)
  // must not have one's token silently overwrite/leak into requests meant
  // for the other.
  var tokenStorageKey = "editbar_token:" + apiBase;
  var LEGACY_TOKEN_KEY = "editbar_token";
  var draftsStorageKey = "editbar_drafts:" + location.host;
  var collapsedStorageKey = "editbar_collapsed:" + location.host;

  var state = {
    published: {},
    drafts: loadDrafts(),
    editing: false,
    token: loadToken(),
    collapsed: loadCollapsed(),
    panelOpen: false,
    tokenRevealed: false,
    originals: new Map(), // edit-id -> text present in the DOM before any override
    // Hosted-only extras below — every fetch that populates these degrades
    // silently (see fetchConfig/fetchBaseline/fetchBlame), so a self-hosted
    // server that doesn't implement these routes just leaves them at their
    // default and the widget behaves exactly as it always has.
    richContent: false, // from /config's features.richContent
    baseline: {}, // edit-id -> updated_at, from /overrides-meta.json
    blame: {}, // edit-id -> { email, at }, from /blame.json
    activeEditors: [], // from /presence
    conflicts: null, // array of { editId, serverValue, serverUpdatedAt } while a save is blocked
    // Plan-gating fields — a self-hosted server (or any /config response
    // missing these) MUST leave editing fully unblocked, so `active`
    // defaults true and everything else defaults to "no gate applies".
    active: true, // from /config's `active` — the single source of truth for whether editing is allowed at all
    planStatus: "active", // from /config's `status` ("active" | "trialing" | "inactive" | "canceled")
    trialEndsAt: null, // from /config's `trialEndsAt`, ms epoch, only set while trialing
    isOwner: false, // from /config's `isOwner` — whether this token belongs to the site's owner
    accountUrl: null, // from /config's `accountUrl` — only meaningful/shown when isOwner
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
      var stored = localStorage.getItem(tokenStorageKey);
      if (stored) return stored;
      // One-time migration from the pre-multi-tenant-safe key so upgrading
      // doesn't silently sign existing admins out.
      var legacy = localStorage.getItem(LEGACY_TOKEN_KEY);
      if (legacy) {
        localStorage.setItem(tokenStorageKey, legacy);
        localStorage.removeItem(LEGACY_TOKEN_KEY);
        return legacy;
      }
      return "";
    } catch (e) {
      return "";
    }
  }

  function loadCollapsed() {
    // #editbar always forces the bar open, even if it was left collapsed —
    // the memorable way for an admin to bring it back without retyping a token.
    if (location.hash === "#editbar") {
      history.replaceState({}, "", location.pathname + location.search);
      return false;
    }
    try {
      return localStorage.getItem(collapsedStorageKey) === "1";
    } catch (e) {
      return false;
    }
  }

  function saveCollapsed() {
    try {
      localStorage.setItem(collapsedStorageKey, state.collapsed ? "1" : "0");
    } catch (e) {}
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

  // Defense-in-depth allowlist sanitizer for richContent, applied here on
  // every render regardless of what the backend claims to have already
  // sanitized at save time. A hosted server (or any future backend
  // implementing this API) sanitizing on save is the primary defense, but
  // this widget ships to every plan and must not blindly trust a `text`
  // value it didn't produce — a bug or bypass in that other, closed-source
  // sanitizer would otherwise become an instant, unfixable-from-here stored
  // XSS against every visitor. Deliberately minimal (no external
  // dependency, matching the "one script tag, zero deps" project goal):
  // a small inline-formatting tag allowlist, no attributes except a
  // scheme-checked <a href>. Not a substitute for a real library if richer
  // markup is ever needed — just enough to make plain "bold/italic/link"
  // editing safe.
  var RICH_ALLOWED_TAGS = {
    B: [], STRONG: [], I: [], EM: [], U: [], BR: [], P: [], SPAN: [],
    UL: [], OL: [], LI: [],
    A: ["href"],
  };
  var RICH_ALLOWED_URL_SCHEMES = ["http:", "https:", "mailto:"];
  // Removed with their entire subtree, not just unwrapped — text content
  // inside these tags isn't meant to be read as document text (a <script>
  // body, raw CSS, foreign-namespace markup).
  var RICH_DANGEROUS_TAGS = {
    SCRIPT: 1, STYLE: 1, IFRAME: 1, OBJECT: 1, EMBED: 1,
    SVG: 1, MATH: 1, TEMPLATE: 1, NOSCRIPT: 1,
  };

  function isSafeRichUrl(value) {
    try {
      return RICH_ALLOWED_URL_SCHEMES.indexOf(new URL(value, location.href).protocol) !== -1;
    } catch (e) {
      return false;
    }
  }

  // Parses into a <template>'s inert content fragment — per spec, elements
  // there (including <img>) don't load resources and scripts don't run, so
  // nothing executes even before we've stripped dangerous nodes/attributes.
  function sanitizeRichHtml(html) {
    var template = document.createElement("template");
    template.innerHTML = html;
    var root = template.content;

    var toRemove = [];
    var toUnwrap = [];
    var walker = document.createTreeWalker(
      root,
      NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_COMMENT
    );
    var node;
    while ((node = walker.nextNode())) {
      if (node.nodeType === Node.COMMENT_NODE) {
        toRemove.push(node);
        continue;
      }
      var tag = node.tagName;
      if (RICH_DANGEROUS_TAGS[tag]) {
        toRemove.push(node);
        continue;
      }
      var allowedAttrs = RICH_ALLOWED_TAGS[tag];
      if (!allowedAttrs) {
        toUnwrap.push(node);
        continue;
      }
      Array.prototype.slice.call(node.attributes).forEach(function (attr) {
        var name = attr.name.toLowerCase();
        if (allowedAttrs.indexOf(name) === -1) {
          node.removeAttribute(attr.name);
        } else if (name === "href" && !isSafeRichUrl(attr.value)) {
          node.removeAttribute(attr.name);
        }
      });
      if (tag === "A") {
        node.setAttribute("rel", "noopener noreferrer");
        node.setAttribute("target", "_blank");
      }
    }
    toRemove.forEach(function (n) {
      if (n.parentNode) n.parentNode.removeChild(n);
    });
    toUnwrap.forEach(function (n) {
      var parent = n.parentNode;
      if (!parent) return;
      while (n.firstChild) parent.insertBefore(n.firstChild, n);
      parent.removeChild(n);
    });

    var out = document.createElement("div");
    out.appendChild(root);
    return out.innerHTML;
  }

  function applyText(el, key, text) {
    if (state.richContent) {
      var safe = sanitizeRichHtml(text);
      if (el.innerHTML !== safe) el.innerHTML = safe;
    } else if (el.textContent !== text) {
      el.textContent = text;
    }
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

  // Hosted-only — a self-hosted server 404s here, which just leaves
  // richContent off (identical to today's plain-text-only behavior) and
  // every plan-gating field at its safe "always active" default below.
  function fetchConfig() {
    return fetch(apiBase + "/config", {
      credentials: "omit",
      headers: state.token ? { Authorization: "Bearer " + state.token } : {},
    })
      .then(function (res) {
        if (!res.ok) throw new Error("no config");
        return res.json();
      })
      .then(function (data) {
        data = data || {};
        state.richContent = !!(data.features && data.features.richContent);
        // Missing entirely (self-hosted, or any older/partial response)
        // MUST mean "always active" — `!!data.active` would instead default
        // an absent field to `false` and silently lock every self-hosted
        // install out of editing. `undefined !== false` is `true`, which is
        // exactly the fallback this needs.
        state.active = data.active !== false;
        state.planStatus = data.status || "active";
        state.trialEndsAt = typeof data.trialEndsAt === "number" ? data.trialEndsAt : null;
        state.isOwner = !!data.isOwner;
        state.accountUrl = data.accountUrl || null;
      })
      .catch(function () {
        state.richContent = false;
        state.active = true;
        state.planStatus = "active";
        state.trialEndsAt = null;
        state.isOwner = false;
        state.accountUrl = null;
      });
  }

  var TRIAL_WARNING_WINDOW_MS = 3 * 24 * 60 * 60 * 1000; // last 3 days of the trial

  function isTrialEndingSoon() {
    var remaining = state.trialEndsAt - Date.now();
    return (
      state.active &&
      state.planStatus === "trialing" &&
      typeof state.trialEndsAt === "number" &&
      remaining > 0 &&
      remaining <= TRIAL_WARNING_WINDOW_MS
    );
  }

  // { editId: updatedAt } for every field currently on the page — echoed
  // back on save so the server can tell a genuine race from a normal save.
  // A field with no stored value yet still gets an entry (null), so even
  // its very first save is checked against "nobody else touched this
  // either" rather than skipping the check just because we've never seen a
  // timestamp for it. Missing entirely on self-hosted (fetch fails), in
  // which case saves simply never carry a baseline and conflict checking is
  // skipped, same as before this feature existed.
  function fetchBaseline() {
    return fetch(apiBase + "/overrides-meta.json", { credentials: "omit" })
      .then(function (res) {
        if (!res.ok) throw new Error("no meta");
        return res.json();
      })
      .then(function (data) {
        data = data || {};
        var baseline = {};
        editableElements().forEach(function (el) {
          var key = el.getAttribute("data-edit-id");
          baseline[key] = Object.prototype.hasOwnProperty.call(data, key) ? data[key] : null;
        });
        state.baseline = baseline;
      })
      .catch(function () {
        state.baseline = state.baseline || {};
      });
  }

  function timeAgo(ts) {
    var diffMin = Math.floor((Date.now() - ts) / 60000);
    if (diffMin < 1) return "just now";
    if (diffMin < 60) return diffMin + "m ago";
    var diffHr = Math.floor(diffMin / 60);
    if (diffHr < 24) return diffHr + "h ago";
    return Math.floor(diffHr / 24) + "d ago";
  }

  // "Who last published this, and when" as a native title tooltip on each
  // field — requires the admin token (same trust boundary as saving), so
  // only fetched once the bar is up.
  function fetchBlame() {
    var keys = editableElements().map(function (el) {
      return el.getAttribute("data-edit-id");
    });
    if (!keys.length) return Promise.resolve();
    return fetch(apiBase + "/blame.json?keys=" + encodeURIComponent(keys.join(",")), {
      headers: { Authorization: "Bearer " + state.token },
    })
      .then(function (res) {
        if (!res.ok) throw new Error("no blame");
        return res.json();
      })
      .then(function (data) {
        state.blame = data || {};
        applyBlameTitles();
      })
      .catch(function () {
        state.blame = state.blame || {};
      });
  }

  function applyBlameTitles() {
    editableElements().forEach(function (el) {
      var info = state.blame[el.getAttribute("data-edit-id")];
      if (info && info.email) {
        el.title = "Last changed by " + info.email + " · " + timeAgo(info.at);
      }
    });
  }

  var presenceTimer = null;

  function heartbeatPresence() {
    fetch(apiBase + "/presence", {
      method: "POST",
      headers: { Authorization: "Bearer " + state.token },
    })
      .then(function (res) {
        if (!res.ok) throw new Error("no presence");
        return res.json();
      })
      .then(function (data) {
        state.activeEditors = (data && data.editors) || [];
        renderPresence();
      })
      .catch(function () {
        /* self-hosted or a transient failure — leave the last known state */
      });
  }

  function startPresenceHeartbeat() {
    heartbeatPresence();
    presenceTimer = setInterval(heartbeatPresence, 30000);
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
    var text = state.richContent ? el.innerHTML : el.textContent;
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
    if (next && !state.active) return; // inactive plan: entering edit mode is a no-op
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
    // The page's own pre-Editbar text for each changed key, from the DOM
    // snapshot taken before any override was ever applied (see
    // applyPublishedAndDrafts). Sent so the backend can show "what this
    // said originally" even for a key's very first edit — it only keeps
    // the first copy it ever receives, so resending it here is harmless.
    var originals = {};
    Object.keys(changes).forEach(function (key) {
      if (state.originals.has(key)) originals[key] = state.originals.get(key);
    });
    // Only for keys we actually have a known updated_at for (from
    // fetchBaseline) — an unmodified/self-hosted baseline of {} means every
    // save skips conflict checking entirely, matching prior behavior.
    var baseline = {};
    Object.keys(changes).forEach(function (key) {
      if (Object.prototype.hasOwnProperty.call(state.baseline, key)) {
        baseline[key] = state.baseline[key];
      }
    });
    setStatus("Saving…", null);
    postOverrides(changes, originals, baseline);
  }

  function postOverrides(changes, originals, baseline) {
    fetch(apiBase + "/overrides", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + state.token,
      },
      body: JSON.stringify({ changes: changes, originals: originals, baseline: baseline }),
    })
      .then(function (res) {
        if (res.status === 409) {
          return res.json().then(function (body) {
            var err = new Error("conflict");
            err.conflicts = (body && body.conflicts) || [];
            throw err;
          });
        }
        if (res.status === 401) throw new Error("unauthorized");
        if (res.status === 402) throw new Error("inactive");
        if (!res.ok) throw new Error("save failed");
        return res.json();
      })
      .then(function (data) {
        state.published = data || state.published;
        clearDrafts();
        setStatus("Saved", "ok");
        renderBarState();
        fetchBaseline();
      })
      .catch(function (err) {
        if (err && err.message === "conflict") {
          state.conflicts = err.conflicts;
          renderConflictState();
          setStatus("", null);
          return;
        }
        if (err && err.message === "inactive") {
          // Config was fetched while still active; the plan lapsed mid-
          // session (trial expired, payment failed). Flip into the same
          // gate a fresh page load would already show, without discarding
          // the draft — setEditing(false) just commits it into
          // state.drafts/localStorage like a normal "Done editing".
          state.active = false;
          setEditing(false);
          renderPlanState();
          renderBarState();
          setStatus("Plan inactive — changes saved locally only", "error");
          return;
        }
        var msg =
          err.message === "unauthorized"
            ? "Invalid token"
            : "Could not save changes";
        setStatus(msg, "error");
      });
  }

  // The whole save was rejected atomically (nothing written) — "keep mine"
  // just bumps the conflicting keys' baseline to what the server now has
  // and retries the exact same drafts, so this time they pass.
  function resolveConflictKeepMine() {
    if (!state.conflicts) return;
    state.conflicts.forEach(function (c) {
      state.baseline[c.editId] = c.serverUpdatedAt;
    });
    state.conflicts = null;
    renderConflictState();
    saveChanges();
  }

  function resolveConflictKeepTheirs() {
    if (!state.conflicts) return;
    state.conflicts.forEach(function (c) {
      delete state.drafts[c.editId];
      var el = editableElements().filter(function (e) {
        return e.getAttribute("data-edit-id") === c.editId;
      })[0];
      if (el) applyText(el, c.editId, c.serverValue || "");
    });
    saveDrafts();
    state.conflicts = null;
    renderConflictState();
    renderBarState();
    fetchBaseline();
    if (Object.keys(state.drafts).length > 0) saveChanges();
  }

  function collapse() {
    if (state.editing) setEditing(false);
    state.collapsed = true;
    state.panelOpen = false;
    saveCollapsed();
    renderBarState();
    renderPanelState();
  }

  function expand() {
    state.collapsed = false;
    saveCollapsed();
    renderBarState();
  }

  function togglePanel() {
    state.panelOpen = !state.panelOpen;
    renderPanelState();
  }

  function buildAdminLink() {
    var url = new URL(location.href);
    url.searchParams.set("edit_token", state.token);
    return url.toString();
  }

  function copyToClipboardFallback(text) {
    var ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    var ok = false;
    try {
      ok = document.execCommand("copy");
    } catch (e) {}
    ta.remove();
    return ok ? Promise.resolve() : Promise.reject(new Error("copy failed"));
  }

  function copyToClipboard(text) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        return navigator.clipboard.writeText(text).catch(function () {
          return copyToClipboardFallback(text);
        });
      }
    } catch (e) {
      /* fall through to the execCommand fallback below */
    }
    return copyToClipboardFallback(text);
  }

  function rotateToken() {
    if (
      !window.confirm(
        "Rotate the admin token? Any other saved admin links will stop working immediately."
      )
    ) {
      return;
    }
    setPanelStatus("Rotating…", null);
    fetch(apiBase + "/token/rotate", {
      method: "POST",
      headers: { Authorization: "Bearer " + state.token },
    })
      .then(function (res) {
        if (res.ok) return res.json();
        return res
          .json()
          .catch(function () {
            return {};
          })
          .then(function (body) {
            throw new Error(body.error || "rotate failed");
          });
      })
      .then(function (data) {
        state.token = data.token;
        try {
          localStorage.setItem(tokenStorageKey, state.token);
        } catch (e) {}
        state.tokenRevealed = true;
        renderPanelState();
        setPanelStatus("Token rotated", "ok");
      })
      .catch(function (err) {
        setPanelStatus(err.message || "Could not rotate token", "error");
      });
  }

  // ---- Bar UI (Shadow DOM) ----------------------------------------------

  // Feather Icons' "settings" gear (MIT) — replaces the plain "⚙" glyph,
  // which rendered inconsistently across platforms/fonts.
  var GEAR_ICON =
    '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>';

  // Same mark as the Editbar dashboard/favicon (see BRAND_MARK_DEFS in the
  // hosted app's pages.js) — one visual identity across product surfaces.
  var BRAND_ICON =
    '<svg width="14" height="14" viewBox="0 0 40 40"><rect width="40" height="40" rx="11" fill="#0a84ff"></rect><rect x="10" y="13.5" width="15" height="4" rx="2" fill="#fff"></rect><rect x="10" y="22.5" width="9.5" height="4" rx="2" fill="#fff" opacity=".75"></rect><rect x="27.5" y="11.5" width="3.2" height="17" rx="1.6" fill="#fff"></rect></svg>';

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
    button.icon, a.icon {
      padding: 7px 9px;
      font-size: 14px;
      line-height: 1;
      opacity: 0.6;
      margin-right: 2px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
    }
    button.icon:hover, a.icon:hover { opacity: 1; }
    a.icon {
      border-radius: 16px;
      cursor: pointer;
      text-decoration: none;
      color: inherit;
      transition: background 0.15s ease, opacity 0.15s ease;
    }
    a.icon:hover { background: rgba(0,0,0,0.06); }
    @media (prefers-color-scheme: dark) {
      a.icon:hover { background: rgba(255,255,255,0.12); }
    }
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
    .tab {
      position: fixed;
      left: 0;
      bottom: 16px;
      z-index: 2147483647;
      width: 44px;
      height: 44px;
      display: flex;
      align-items: center;
      justify-content: center;
      border-radius: 0 16px 16px 0;
      font-size: 18px;
      color: #1c1c1e;
      background: rgba(255, 255, 255, 0.5);
      backdrop-filter: blur(28px) saturate(1.9);
      -webkit-backdrop-filter: blur(28px) saturate(1.9);
      box-shadow:
        0 0 0 0.5px rgba(0,0,0,0.05),
        inset 0 1px 0 rgba(255,255,255,0.7),
        0 2px 6px rgba(0,0,0,0.06),
        0 8px 24px rgba(0,0,0,0.16);
      cursor: pointer;
      border: none;
      padding: 0;
      animation: editbar-in 0.35s cubic-bezier(0.16, 1, 0.3, 1);
      transition: transform 0.15s ease, background 0.15s ease;
    }
    .tab:hover { transform: translateX(4px); }
    .tab:active { transform: translateX(2px) scale(0.96); }
    @media (prefers-color-scheme: dark) {
      .tab {
        color: #f2f2f7;
        background: rgba(30, 30, 32, 0.5);
        box-shadow:
          0 0 0 0.5px rgba(0,0,0,0.3),
          inset 0 1px 0 rgba(255,255,255,0.12),
          0 2px 6px rgba(0,0,0,0.3),
          0 8px 24px rgba(0,0,0,0.45);
      }
    }
    .tab .badge {
      position: absolute;
      top: 4px;
      right: 6px;
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: #0a84ff;
      box-shadow: 0 0 0 2px rgba(255,255,255,0.6);
    }
    @media (prefers-color-scheme: dark) {
      .tab .badge { box-shadow: 0 0 0 2px rgba(30,30,32,0.8); }
    }
    .panel {
      position: fixed;
      left: 16px;
      bottom: 68px;
      z-index: 2147483647;
      display: none;
      flex-direction: column;
      gap: 10px;
      width: 260px;
      padding: 14px;
      border-radius: 18px;
      font-family: -apple-system, BlinkMacSystemFont, "Inter", "SF Pro Text", system-ui, sans-serif;
      font-size: 13px;
      color: #1c1c1e;
      background: rgba(255, 255, 255, 0.7);
      backdrop-filter: blur(28px) saturate(1.9);
      -webkit-backdrop-filter: blur(28px) saturate(1.9);
      box-shadow:
        0 0 0 0.5px rgba(0,0,0,0.05),
        inset 0 1px 0 rgba(255,255,255,0.7),
        0 2px 6px rgba(0,0,0,0.06),
        0 12px 32px rgba(0,0,0,0.16);
      animation: editbar-in 0.2s cubic-bezier(0.16, 1, 0.3, 1);
    }
    @media (prefers-color-scheme: dark) {
      .panel {
        color: #f2f2f7;
        background: rgba(30, 30, 32, 0.7);
        box-shadow:
          0 0 0 0.5px rgba(0,0,0,0.3),
          inset 0 1px 0 rgba(255,255,255,0.12),
          0 2px 6px rgba(0,0,0,0.3),
          0 12px 32px rgba(0,0,0,0.45);
      }
    }
    .panel-label {
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      opacity: 0.55;
      font-weight: 600;
    }
    .panel-row {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .token-value {
      flex: 1;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 12px;
      background: rgba(0,0,0,0.06);
      border-radius: 8px;
      padding: 6px 8px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    @media (prefers-color-scheme: dark) {
      .token-value { background: rgba(255,255,255,0.1); }
    }
    button.small {
      padding: 6px 10px;
      font-size: 12px;
      background: rgba(0,0,0,0.06);
      flex: none;
    }
    @media (prefers-color-scheme: dark) {
      button.small { background: rgba(255,255,255,0.1); }
    }
    button.small:hover { background: rgba(0,0,0,0.1); }
    @media (prefers-color-scheme: dark) {
      button.small:hover { background: rgba(255,255,255,0.16); }
    }
    button.full { width: 100%; }
    button.danger { color: #ff3b30; }
    .panel .status { padding: 0; }
    .presence {
      display: none;
      align-items: center;
      justify-content: center;
      min-width: 18px;
      height: 18px;
      padding: 0 5px;
      margin-left: 2px;
      border-radius: 9px;
      font-size: 11px;
      font-weight: 600;
      background: rgba(10,132,255,0.16);
      color: #0a84ff;
    }
    .conflict {
      position: fixed;
      left: 16px;
      bottom: 68px;
      z-index: 2147483647;
      display: none;
      flex-direction: column;
      gap: 10px;
      width: 280px;
      padding: 14px;
      border-radius: 18px;
      font-family: -apple-system, BlinkMacSystemFont, "Inter", "SF Pro Text", system-ui, sans-serif;
      font-size: 13px;
      color: #1c1c1e;
      background: rgba(255, 214, 170, 0.85);
      backdrop-filter: blur(28px) saturate(1.9);
      -webkit-backdrop-filter: blur(28px) saturate(1.9);
      box-shadow:
        0 0 0 0.5px rgba(0,0,0,0.05),
        inset 0 1px 0 rgba(255,255,255,0.7),
        0 2px 6px rgba(0,0,0,0.06),
        0 12px 32px rgba(0,0,0,0.16);
      animation: editbar-in 0.2s cubic-bezier(0.16, 1, 0.3, 1);
    }
    @media (prefers-color-scheme: dark) {
      .conflict {
        color: #f2f2f7;
        background: rgba(90, 58, 20, 0.85);
        box-shadow:
          0 0 0 0.5px rgba(0,0,0,0.3),
          inset 0 1px 0 rgba(255,255,255,0.12),
          0 2px 6px rgba(0,0,0,0.3),
          0 12px 32px rgba(0,0,0,0.45);
      }
    }
    .conflict-title { font-weight: 600; }
    .conflict-list { display: flex; flex-direction: column; gap: 4px; }
    .conflict-row {
      font-size: 12px;
      opacity: 0.85;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .conflict-actions { display: flex; gap: 8px; }
    button:disabled { opacity: 0.4; cursor: default; }
    .plan-banner {
      position: fixed;
      left: 16px;
      bottom: 68px;
      z-index: 2147483647;
      display: none;
      align-items: center;
      gap: 10px;
      max-width: 300px;
      padding: 10px 14px;
      border-radius: 18px;
      font-family: -apple-system, BlinkMacSystemFont, "Inter", "SF Pro Text", system-ui, sans-serif;
      font-size: 12px;
      line-height: 1.35;
      color: #1c1c1e;
      background: rgba(255, 214, 170, 0.85);
      backdrop-filter: blur(28px) saturate(1.9);
      -webkit-backdrop-filter: blur(28px) saturate(1.9);
      box-shadow:
        0 0 0 0.5px rgba(0,0,0,0.05),
        inset 0 1px 0 rgba(255,255,255,0.7),
        0 2px 6px rgba(0,0,0,0.06),
        0 12px 32px rgba(0,0,0,0.16);
      animation: editbar-in 0.2s cubic-bezier(0.16, 1, 0.3, 1);
    }
    .plan-banner.trial { background: rgba(200, 230, 255, 0.85); }
    @media (prefers-color-scheme: dark) {
      .plan-banner { color: #f2f2f7; background: rgba(90, 58, 20, 0.85); }
      .plan-banner.trial { background: rgba(20, 55, 90, 0.85); }
    }
    .plan-banner-link { color: inherit; font-weight: 600; text-decoration: underline; white-space: nowrap; }
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
    var presence = h("span", { class: "presence" });
    var saveBtn = h("button", { class: "primary" }, "Save changes");
    var discardBtn = h("button", {}, "Discard");
    var status = h("span", { class: "status" });
    var settingsBtn = h("button", { class: "icon", title: "Settings" });
    settingsBtn.innerHTML = GEAR_ICON;
    var brandLink = h("a", {
      class: "icon",
      href: "https://editbar.online",
      target: "_blank",
      rel: "noopener noreferrer",
      title: "Made with Editbar",
    });
    brandLink.innerHTML = BRAND_ICON;
    var collapseBtn = h("button", { class: "icon", title: "Collapse" }, "✕");

    editBtn.addEventListener("click", function () {
      setEditing(!state.editing);
    });
    saveBtn.addEventListener("click", saveChanges);
    discardBtn.addEventListener("click", discardDrafts);
    settingsBtn.addEventListener("click", togglePanel);
    collapseBtn.addEventListener("click", collapse);

    var groupLeft = h("div", { class: "group" });
    groupLeft.appendChild(dot);
    groupLeft.appendChild(editBtn);
    groupLeft.appendChild(presence);

    // Only meaningful once fetchConfig() confirms the site is on a
    // richContent plan — hidden otherwise, and its buttons are inert
    // no-ops when nothing is focused/contenteditable.
    var richDivider = h("div", { class: "divider" });
    var richToolbar = h("div", { class: "group" });
    var boldBtn = h("button", { class: "icon", title: "Bold" }, "B");
    var italicBtn = h("button", { class: "icon", title: "Italic" }, "I");
    var linkBtn = h("button", { class: "icon", title: "Insert link" }, "🔗");
    var imageBtn = h("button", { class: "icon", title: "Insert image" }, "🖼");
    [boldBtn, italicBtn, linkBtn, imageBtn].forEach(function (btn) {
      // Without this, the mousedown itself blurs the contenteditable field
      // before click fires, losing the text selection execCommand needs.
      btn.addEventListener("mousedown", function (e) {
        e.preventDefault();
      });
    });
    boldBtn.addEventListener("click", function () {
      document.execCommand("bold");
    });
    italicBtn.addEventListener("click", function () {
      document.execCommand("italic");
    });
    linkBtn.addEventListener("click", function () {
      var url = window.prompt("Link URL:");
      if (url) document.execCommand("createLink", false, url);
    });
    imageBtn.addEventListener("click", function () {
      var url = window.prompt("Image URL:");
      if (url) document.execCommand("insertImage", false, url);
    });
    richToolbar.appendChild(boldBtn);
    richToolbar.appendChild(italicBtn);
    richToolbar.appendChild(linkBtn);
    richToolbar.appendChild(imageBtn);

    var groupRight = h("div", { class: "group" });
    groupRight.appendChild(saveBtn);
    groupRight.appendChild(discardBtn);
    groupRight.appendChild(status);

    bar.appendChild(groupLeft);
    bar.appendChild(richDivider);
    bar.appendChild(richToolbar);
    bar.appendChild(h("div", { class: "divider" }));
    bar.appendChild(groupRight);
    bar.appendChild(h("div", { class: "divider" }));
    bar.appendChild(settingsBtn);
    bar.appendChild(brandLink);
    bar.appendChild(collapseBtn);
    shadow.appendChild(bar);

    var conflictBox = h("div", { class: "conflict" });
    var conflictTitle = h("div", { class: "conflict-title" }, "Someone else changed this");
    var conflictList = h("div", { class: "conflict-list" });
    var conflictActions = h("div", { class: "conflict-actions" });
    var keepMineBtn = h("button", { class: "small" }, "Use mine anyway");
    var keepTheirsBtn = h("button", { class: "small danger" }, "Keep theirs");
    keepMineBtn.addEventListener("click", resolveConflictKeepMine);
    keepTheirsBtn.addEventListener("click", resolveConflictKeepTheirs);
    conflictActions.appendChild(keepMineBtn);
    conflictActions.appendChild(keepTheirsBtn);
    conflictBox.appendChild(conflictTitle);
    conflictBox.appendChild(conflictList);
    conflictBox.appendChild(conflictActions);
    shadow.appendChild(conflictBox);

    var planBanner = h("div", { class: "plan-banner" });
    var planBannerText = h("span", { class: "plan-banner-text" });
    var planBannerLink = h(
      "a",
      { class: "plan-banner-link", target: "_blank", rel: "noopener noreferrer" },
      "Manage plan"
    );
    planBanner.appendChild(planBannerText);
    planBanner.appendChild(planBannerLink);
    shadow.appendChild(planBanner);

    var tab = h("button", { class: "tab", title: "Open Editbar" }, "✏️");
    var tabBadge = h("span", { class: "badge" });
    tab.appendChild(tabBadge);
    tab.addEventListener("click", expand);
    shadow.appendChild(tab);

    var panel = h("div", { class: "panel" });
    var tokenLabel = h("span", { class: "panel-label" }, "Admin token");
    var tokenValue = h("code", { class: "token-value" });
    var revealBtn = h("button", { class: "small" }, "Show");
    var tokenRow = h("div", { class: "panel-row" });
    tokenRow.appendChild(tokenValue);
    tokenRow.appendChild(revealBtn);

    var copyTokenBtn = h("button", { class: "small" }, "Copy token");
    var copyLinkBtn = h("button", { class: "small" }, "Copy admin link");
    var actionsRow = h("div", { class: "panel-row" });
    actionsRow.appendChild(copyTokenBtn);
    actionsRow.appendChild(copyLinkBtn);

    var rotateBtn = h("button", { class: "small danger full" }, "Rotate token");
    var panelStatus = h("div", { class: "status" });

    revealBtn.addEventListener("click", function () {
      state.tokenRevealed = !state.tokenRevealed;
      renderPanelState();
    });
    copyTokenBtn.addEventListener("click", function () {
      copyToClipboard(state.token)
        .then(function () {
          setPanelStatus("Token copied", "ok");
        })
        .catch(function () {
          setPanelStatus("Could not copy — copy it manually", "error");
        });
    });
    copyLinkBtn.addEventListener("click", function () {
      copyToClipboard(buildAdminLink())
        .then(function () {
          setPanelStatus("Link copied", "ok");
        })
        .catch(function () {
          setPanelStatus("Could not copy — copy it manually", "error");
        });
    });
    rotateBtn.addEventListener("click", rotateToken);

    panel.appendChild(tokenLabel);
    panel.appendChild(tokenRow);
    panel.appendChild(actionsRow);
    panel.appendChild(rotateBtn);
    panel.appendChild(panelStatus);
    shadow.appendChild(panel);

    document.body.appendChild(host);

    els = {
      host,
      bar,
      tab,
      tabBadge,
      panel,
      tokenValue,
      revealBtn,
      panelStatus,
      dot,
      editBtn,
      saveBtn,
      discardBtn,
      status,
      presence,
      richDivider,
      richToolbar,
      conflictBox,
      conflictList,
      planBanner,
      planBannerText,
      planBannerLink,
    };
    renderBarState();
    renderPanelState();
    renderConflictState();
    renderPlanState();
    renderPresence();
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
    els.editBtn.disabled = !state.active;
    els.dot.classList.toggle("editing", state.editing);
    els.saveBtn.disabled = draftCount === 0;
    els.saveBtn.textContent =
      draftCount > 0 ? "Save changes (" + draftCount + ")" : "Save changes";
    els.discardBtn.style.display = draftCount > 0 ? "" : "none";

    els.bar.style.display = state.collapsed ? "none" : "flex";
    els.tab.style.display = state.collapsed ? "flex" : "none";
    els.tabBadge.style.display = draftCount > 0 ? "block" : "none";

    var showRichToolbar = state.richContent && state.editing;
    els.richDivider.style.display = showRichToolbar ? "block" : "none";
    els.richToolbar.style.display = showRichToolbar ? "flex" : "none";
  }

  function renderPresence() {
    if (!els.presence) return;
    var n = state.activeEditors.length;
    if (n === 0) {
      els.presence.style.display = "none";
      return;
    }
    els.presence.style.display = "inline-flex";
    els.presence.textContent = "+" + n;
    els.presence.title =
      state.activeEditors
        .map(function (e) {
          return e.email;
        })
        .join(", ") + (n === 1 ? " is" : " are") + " also editing";
  }

  function renderConflictState() {
    if (!els.conflictBox) return;
    var conflicts = state.conflicts;
    if (!conflicts || !conflicts.length) {
      els.conflictBox.style.display = "none";
      return;
    }
    els.conflictBox.style.display = "flex";
    els.conflictList.textContent = "";
    conflicts.forEach(function (c) {
      els.conflictList.appendChild(
        h("div", { class: "conflict-row" }, c.editId + ": " + (c.serverValue || "(empty)"))
      );
    });
  }

  // Blocking (inactive) takes priority over the informational (trial-ending)
  // state, since the two can never legitimately co-occur — inactive means
  // the writable window has already closed, ending-soon means it hasn't yet.
  function renderPlanState() {
    if (!els.planBanner) return;
    if (!state.active) {
      els.planBanner.className = "plan-banner inactive";
      els.planBanner.style.display = "flex";
      if (state.isOwner) {
        els.planBannerText.textContent = "This site's plan isn't active — editing is paused.";
        els.planBannerLink.style.display = "inline";
        els.planBannerLink.href = state.accountUrl || "#";
      } else {
        els.planBannerText.textContent = "Editing is paused. Ask the site owner to reactivate the plan.";
        els.planBannerLink.style.display = "none";
      }
      return;
    }
    if (isTrialEndingSoon()) {
      var daysLeft = Math.max(1, Math.ceil((state.trialEndsAt - Date.now()) / 86400000));
      var daysLabel = daysLeft + (daysLeft === 1 ? " day" : " days");
      els.planBanner.className = "plan-banner trial";
      els.planBanner.style.display = "flex";
      if (state.isOwner) {
        els.planBannerText.textContent = "Trial ends in " + daysLabel + " — add a plan to keep editing.";
        els.planBannerLink.style.display = "inline";
        els.planBannerLink.href = state.accountUrl || "#";
      } else {
        els.planBannerText.textContent = "Trial ends in " + daysLabel + ". Ask the site owner to add a plan.";
        els.planBannerLink.style.display = "none";
      }
      return;
    }
    els.planBanner.style.display = "none";
  }

  function maskToken(token) {
    return "•".repeat(Math.min(token.length, 24));
  }

  function setPanelStatus(text, kind) {
    if (!els.panelStatus) return;
    els.panelStatus.textContent = text || "";
    els.panelStatus.className = "status" + (kind ? " " + kind : "");
    if (kind === "ok") {
      setTimeout(function () {
        if (els.panelStatus) {
          els.panelStatus.textContent = "";
          els.panelStatus.className = "status";
        }
      }, 2000);
    }
  }

  function renderPanelState() {
    if (!els.panel) return;
    els.panel.style.display =
      state.panelOpen && !state.collapsed ? "flex" : "none";
    els.tokenValue.textContent = state.tokenRevealed
      ? state.token
      : maskToken(state.token);
    els.revealBtn.textContent = state.tokenRevealed ? "Hide" : "Show";
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

    Promise.all([fetchPublished(), fetchConfig()]).then(function () {
      applyPublishedAndDrafts();
      if (state.token) {
        createBar();
        fetchBaseline();
        fetchBlame();
        startPresenceHeartbeat();
      }
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
