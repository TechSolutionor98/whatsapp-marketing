/*!
 * AI chat widget for websites (AI Agents page).
 * Add to a page:  <script src="https://YOUR-PLATFORM/widget.js" data-agent="ag_…" async></script>
 * Options (attributes on the script tag):
 *   data-open="true"       open the chat when the page loads (bigger screens only)
 *   data-launcher="false"  no round button: open it from your own button with ChatAgent.open()
 *   data-position="left"   button on the left (default: what the agent is set to)
 * JavaScript: ChatAgent.open(), ChatAgent.close(), ChatAgent.toggle(), ChatAgent.send("text")
 */
(function () {
  'use strict';
  var script =
    document.currentScript ||
    (function () {
      var all = document.querySelectorAll('script[data-agent]');
      return all[all.length - 1] || null;
    })();
  if (!script) return;
  var agentId = (script.getAttribute('data-agent') || '').trim();
  if (!/^ag_[a-f0-9]{20}$/.test(agentId)) {
    console.warn('[chat] The script tag needs data-agent="ag_…" (copy it from AI Agents → Add to website).');
    return;
  }
  var loaded = (window.__chatAgents = window.__chatAgents || {});
  if (loaded[agentId]) return;
  loaded[agentId] = true;

  var origin;
  try {
    origin = new URL(script.src, location.href).origin;
  } catch (e) {
    origin = location.origin;
  }
  var API = origin + '/api/agent/' + agentId;
  var STORE = 'chat_agent_' + agentId;
  var KEEP_MS = 7 * 24 * 3600 * 1000; // a chat left alone for a week starts fresh
  var attr = function (n) {
    return (script.getAttribute('data-' + n) || '').trim().toLowerCase();
  };

  // ---- saved chat (this browser only) ----
  function readState() {
    try {
      var s = JSON.parse(localStorage.getItem(STORE) || 'null');
      if (s && Date.now() - (s.at || 0) < KEEP_MS && Array.isArray(s.m)) return s;
    } catch (e) {}
    return { s: '', m: [], at: Date.now() };
  }
  var state = readState();
  function saveState() {
    state.at = Date.now();
    state.m = state.m.slice(-60);
    try {
      localStorage.setItem(STORE, JSON.stringify(state));
    } catch (e) {}
  }

  // ---- helpers ----
  function esc(t) {
    return String(t).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  // Plain text → safe HTML: links, *bold*, line breaks. Everything else is escaped.
  function fmt(t) {
    var h = esc(t);
    h = h.replace(/https?:\/\/[^\s<]+[^\s<.,;:!?)\]'"*]/g, function (u) {
      return '<a href="' + u + '" target="_blank" rel="noopener noreferrer nofollow">' + u + '</a>';
    });
    h = h.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
    h = h.replace(/(^|[\s(>])\*([^*\n<>]+)\*(?=[\s).,!?:;<]|$)/g, '$1<strong>$2</strong>');
    return h.replace(/\n/g, '<br>');
  }
  function textOn(hex) {
    var m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
    if (!m) return '#fff';
    var n = parseInt(m[1], 16);
    var ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map(function (v) {
      v /= 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    });
    var L = 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
    return L > 0.45 ? '#111827' : '#ffffff';
  }
  function initials(name) {
    var w = String(name || '').trim().split(/\s+/).filter(Boolean);
    return ((w[0] || '?')[0] + (w[1] ? w[1][0] : '')).toUpperCase();
  }
  var ICON = {
    chat: '<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>',
    down: '<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>',
    x: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M18 6L6 18M6 6l12 12"/></svg>',
    reset: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/></svg>',
    send: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z"/></svg>',
    wa: '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="M17.5 14.4c-.3-.1-1.7-.8-2-.9-.3-.1-.5-.1-.7.1-.2.3-.8.9-.9 1.1-.2.2-.3.2-.6.1-.3-.1-1.2-.5-2.3-1.4-.9-.8-1.4-1.7-1.6-2-.2-.3 0-.5.1-.6l.4-.5c.1-.2.2-.3.3-.5.1-.2 0-.4 0-.5l-.9-2.2c-.2-.6-.5-.5-.7-.5h-.6c-.2 0-.5.1-.8.4-.3.3-1 1-1 2.4s1 2.8 1.2 3c.1.2 2 3.1 4.9 4.3.7.3 1.2.5 1.7.6.7.2 1.3.2 1.8.1.6-.1 1.7-.7 1.9-1.4.2-.7.2-1.3.2-1.4-.1-.1-.3-.2-.6-.3zM12 21.8c-1.8 0-3.5-.5-5-1.4l-.4-.2-3.7 1 1-3.6-.2-.4c-1-1.6-1.5-3.4-1.5-5.2C2.2 6.6 6.6 2.2 12 2.2c2.6 0 5.1 1 6.9 2.9 1.8 1.8 2.9 4.3 2.9 6.9 0 5.4-4.4 9.8-9.8 9.8zm8.4-18.2C18.2 1.3 15.2.1 12 .1 5.5.1.1 5.4.1 12c0 2.1.5 4.1 1.6 5.9L0 24l6.3-1.7c1.7.9 3.7 1.4 5.7 1.4 6.6 0 11.9-5.3 11.9-11.9 0-3.2-1.2-6.2-3.5-8.2z"/></svg>',
  };

  function boot(cfg) {
    var color = cfg.color || '#16a34a';
    var ink = textOn(color);
    var left = (attr('position') || cfg.position) === 'left';
    var showLauncher = attr('launcher') !== 'false';
    var maxLen = cfg.max_message || 1000;

    var host = document.createElement('div');
    host.setAttribute('data-chat-agent', agentId);
    host.style.cssText = 'position:fixed;z-index:2147483000;' + (left ? 'left:0;' : 'right:0;') + 'bottom:0;width:0;height:0;';
    var root = host.attachShadow ? host.attachShadow({ mode: 'open' }) : host;
    var side = left ? 'left' : 'right';
    root.innerHTML =
      '<style>' +
      ':host{all:initial}' +
      '*{box-sizing:border-box;font-family:system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,"Noto Sans",sans-serif}' +
      '.launch{position:fixed;bottom:20px;' + side + ':20px;width:58px;height:58px;border-radius:50%;border:0;cursor:pointer;background:' + color + ';color:' + ink + ';display:flex;align-items:center;justify-content:center;box-shadow:0 6px 20px rgba(0,0,0,.22);transition:transform .15s ease}' +
      '.launch:hover{transform:scale(1.06)}.launch:focus-visible{outline:3px solid ' + color + ';outline-offset:3px}' +
      '.teaser{position:fixed;bottom:88px;' + side + ':20px;max-width:260px;background:#fff;color:#111827;border-radius:14px;padding:12px 34px 12px 14px;font-size:14px;line-height:1.45;box-shadow:0 8px 28px rgba(0,0,0,.16);cursor:pointer;animation:pop .25s ease}' +
      '.teaser button{position:absolute;top:6px;right:6px;border:0;background:none;color:#6b7280;cursor:pointer;padding:4px;line-height:0;border-radius:6px}' +
      '.panel{position:fixed;bottom:92px;' + side + ':20px;width:380px;height:min(620px,calc(100vh - 116px));background:#fff;color:#111827;border-radius:18px;box-shadow:0 16px 48px rgba(0,0,0,.24);display:flex;flex-direction:column;overflow:hidden;animation:pop .2s ease}' +
      '.panel[hidden],.teaser[hidden],.launch[hidden]{display:none}' +
      '@keyframes pop{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}' +
      '.head{background:' + color + ';color:' + ink + ';padding:14px 12px 14px 16px;display:flex;align-items:center;gap:11px;flex:none}' +
      '.av{width:38px;height:38px;border-radius:50%;background:rgba(255,255,255,.22);display:flex;align-items:center;justify-content:center;font-weight:700;font-size:14px;flex:none}' +
      '.who{flex:1;min-width:0}.name{font-weight:700;font-size:15px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
      '.sub{font-size:12.5px;opacity:.88;display:flex;align-items:center;gap:6px;margin-top:1px}.sub i{width:7px;height:7px;border-radius:50%;background:#4ade80;display:inline-block;box-shadow:0 0 0 2px rgba(255,255,255,.35)}' +
      '.hb{border:0;background:transparent;color:inherit;cursor:pointer;width:34px;height:34px;border-radius:9px;display:flex;align-items:center;justify-content:center;opacity:.9}.hb:hover{background:rgba(255,255,255,.18);opacity:1}' +
      '.hb:focus-visible{outline:2px solid currentColor}' +
      '.body{flex:1;overflow-y:auto;padding:16px 14px 8px;background:#f6f7f9;display:flex;flex-direction:column;gap:8px;overscroll-behavior:contain}' +
      '.msg{max-width:85%;padding:9px 12px;border-radius:14px;font-size:14px;line-height:1.5;overflow-wrap:anywhere;white-space:normal}' +
      '.msg a{color:inherit;text-decoration:underline}' +
      '.a{align-self:flex-start;background:#fff;border:1px solid #e5e7eb;border-bottom-left-radius:5px}' +
      '.v{align-self:flex-end;background:' + color + ';color:' + ink + ';border-bottom-right-radius:5px}' +
      '.e{align-self:center;background:#fef2f2;color:#991b1b;border:1px solid #fecaca;font-size:13px;text-align:center}' +
      '.wa{display:inline-flex;align-items:center;gap:7px;margin-top:9px;background:#25d366;color:#fff !important;text-decoration:none !important;font-weight:600;font-size:13.5px;padding:8px 12px;border-radius:10px}' +
      '.wa:hover{background:#1ebe5b}' +
      '.chips{display:flex;flex-wrap:wrap;gap:6px;margin:2px 0 4px}' +
      '.chip{border:1px solid ' + color + ';color:#111827;background:#fff;border-radius:999px;padding:6px 11px;font-size:13px;cursor:pointer;text-align:left;line-height:1.3}' +
      '.chip:hover{background:#f3f4f6}' +
      '.typing{align-self:flex-start;background:#fff;border:1px solid #e5e7eb;border-radius:14px;border-bottom-left-radius:5px;padding:12px 14px;display:flex;gap:4px}' +
      '.typing span{width:7px;height:7px;border-radius:50%;background:#9ca3af;animation:blink 1.2s infinite}' +
      '.typing span:nth-child(2){animation-delay:.2s}.typing span:nth-child(3){animation-delay:.4s}' +
      '@keyframes blink{0%,80%,100%{opacity:.3}40%{opacity:1}}' +
      '.foot{border-top:1px solid #e5e7eb;padding:10px 10px 8px;background:#fff;flex:none}' +
      '.row{display:flex;align-items:flex-end;gap:8px}' +
      'textarea{flex:1;resize:none;border:1px solid #d1d5db;border-radius:12px;padding:10px 12px;font-size:14px;line-height:1.4;max-height:120px;min-height:42px;outline:none;color:#111827;background:#fff}' +
      'textarea:focus{border-color:' + color + ';box-shadow:0 0 0 3px rgba(0,0,0,.06)}' +
      '.send{width:42px;height:42px;border-radius:12px;border:0;background:' + color + ';color:' + ink + ';cursor:pointer;display:flex;align-items:center;justify-content:center;flex:none}' +
      '.send:disabled{opacity:.45;cursor:default}' +
      '.note{font-size:11px;color:#6b7280;text-align:center;margin-top:6px}' +
      '@media (max-width:480px){.panel{inset:0;width:auto;height:100%;height:100dvh;border-radius:0;bottom:0}.launch.open{display:none}.teaser{max-width:calc(100vw - 110px)}' +
      '.foot{padding-bottom:calc(8px + env(safe-area-inset-bottom))}}' +
      '@media (prefers-reduced-motion:reduce){.panel,.teaser{animation:none}.typing span{animation:none}.launch{transition:none}}' +
      '</style>' +
      '<div class="teaser" hidden role="button" tabindex="0"><span class="tt"></span><button type="button" aria-label="Dismiss">' + ICON.x + '</button></div>' +
      '<div class="panel" hidden role="dialog" aria-label="' + esc(cfg.name) + ' chat">' +
      '<div class="head"><div class="av" aria-hidden="true">' + esc(initials(cfg.name)) + '</div>' +
      '<div class="who"><div class="name">' + esc(cfg.name) + '</div><div class="sub"><i></i><span>' + esc(cfg.subtitle || 'AI assistant') + '</span></div></div>' +
      '<button type="button" class="hb reset" aria-label="Start a new chat" title="Start a new chat">' + ICON.reset + '</button>' +
      '<button type="button" class="hb close" aria-label="Close chat" title="Close">' + ICON.x + '</button></div>' +
      '<div class="body" aria-live="polite"></div>' +
      '<form class="foot"><div class="row"><textarea rows="1" maxlength="' + maxLen + '" placeholder="Type your message…" aria-label="Your message"></textarea>' +
      '<button type="submit" class="send" aria-label="Send">' + ICON.send + '</button></div>' +
      '<div class="note">AI assistant · it can make mistakes</div></form>' +
      '</div>' +
      '<button type="button" class="launch" aria-label="Open chat" aria-expanded="false"' + (showLauncher ? '' : ' hidden') + '>' + ICON.chat + '</button>';
    document.body.appendChild(host);

    var $ = function (s) {
      return root.querySelector(s);
    };
    var panel = $('.panel'),
      body = $('.body'),
      launch = $('.launch'),
      input = $('textarea'),
      sendBtn = $('.send'),
      teaser = $('.teaser');
    var busy = false;
    var isOpen = false;

    function waButton(url) {
      return '<br><a class="wa" href="' + esc(url) + '" target="_blank" rel="noopener noreferrer">' + ICON.wa + 'Chat on WhatsApp</a>';
    }
    function render() {
      var h = '<div class="msg a">' + fmt(cfg.greeting || 'Hi! How can I help?') + '</div>';
      var visitorSaid = state.m.some(function (m) {
        return m.r === 'v';
      });
      if (!visitorSaid && cfg.suggestions && cfg.suggestions.length) {
        h += '<div class="chips">' + cfg.suggestions.map(function (s) {
          return '<button type="button" class="chip">' + esc(s) + '</button>';
        }).join('') + '</div>';
      }
      state.m.forEach(function (m) {
        h += '<div class="msg ' + (m.r === 'v' ? 'v' : m.r === 'e' ? 'e' : 'a') + '">' + fmt(m.t) + (m.w ? waButton(m.w) : '') + '</div>';
      });
      if (busy) h += '<div class="typing" aria-label="Typing"><span></span><span></span><span></span></div>';
      body.innerHTML = h;
      body.scrollTop = body.scrollHeight;
      sendBtn.disabled = busy || !input.value.trim();
    }
    function grow() {
      input.style.height = 'auto';
      input.style.height = Math.min(120, input.scrollHeight) + 'px';
      sendBtn.disabled = busy || !input.value.trim();
    }
    function open() {
      if (isOpen) return;
      isOpen = true;
      teaser.hidden = true;
      panel.hidden = false;
      launch.innerHTML = ICON.down;
      launch.classList.add('open');
      launch.setAttribute('aria-expanded', 'true');
      launch.setAttribute('aria-label', 'Close chat');
      render();
      setTimeout(function () {
        input.focus();
      }, 60);
    }
    function close() {
      if (!isOpen) return;
      isOpen = false;
      panel.hidden = true;
      launch.innerHTML = ICON.chat;
      launch.classList.remove('open');
      launch.setAttribute('aria-expanded', 'false');
      launch.setAttribute('aria-label', 'Open chat');
      if (showLauncher) launch.focus();
    }
    function send(text) {
      text = String(text || '').trim().slice(0, maxLen);
      if (!text || busy) return;
      open();
      state.m = state.m.filter(function (m) {
        return m.r !== 'e';
      });
      state.m.push({ r: 'v', t: text });
      busy = true;
      saveState();
      render();
      fetch(API + '/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' }, // a "simple" request: no extra preflight round trip
        body: JSON.stringify({ message: text, session: state.s || undefined, page: location.href.slice(0, 300) }),
        credentials: 'omit',
      })
        .then(function (r) {
          return r.json().then(
            function (d) {
              return { ok: r.ok, d: d };
            },
            function () {
              return { ok: false, d: {} };
            }
          );
        })
        .then(function (x) {
          busy = false;
          if (x.ok && x.d.reply) {
            if (x.d.session) state.s = x.d.session;
            state.m.push({ r: 'a', t: x.d.reply, w: x.d.whatsapp || undefined });
          } else {
            var err = (x.d && x.d.error) || {};
            if (err.code === 'chat_full') state.s = '';
            state.m.pop(); // not answered: give the text back to try again
            input.value = text;
            state.m.push({ r: 'e', t: err.message || 'Something went wrong. Please try again.' });
          }
          saveState();
          render();
          grow();
        })
        .catch(function () {
          busy = false;
          state.m.pop();
          input.value = text;
          state.m.push({ r: 'e', t: "Couldn't reach the assistant. Check your internet connection and try again." });
          saveState();
          render();
          grow();
        });
    }

    launch.addEventListener('click', function () {
      isOpen ? close() : open();
    });
    $('.close').addEventListener('click', close);
    $('.reset').addEventListener('click', function () {
      if (busy) return;
      state = { s: '', m: [], at: Date.now() };
      saveState();
      render();
      input.focus();
    });
    function submitInput() {
      if (busy || !input.value.trim()) return;
      var t = input.value;
      input.value = '';
      grow();
      send(t);
    }
    $('form').addEventListener('submit', function (e) {
      e.preventDefault();
      submitInput();
    });
    input.addEventListener('input', grow);
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        submitInput();
      }
    });
    body.addEventListener('click', function (e) {
      var chip = e.target.closest && e.target.closest('.chip');
      if (chip) send(chip.textContent);
    });
    panel.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') close();
    });
    teaser.addEventListener('click', function (e) {
      if (e.target.closest && e.target.closest('button')) {
        teaser.hidden = true;
        try {
          sessionStorage.setItem(STORE + '_t', '1');
        } catch (er) {}
        e.stopPropagation();
        return;
      }
      open();
    });
    teaser.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        open();
      }
    });

    // A small hello next to the button, once per visit, for people who haven't chatted yet.
    var teased = false;
    try {
      teased = !!sessionStorage.getItem(STORE + '_t');
    } catch (e) {}
    if (showLauncher && !teased && !state.m.length && cfg.greeting) {
      setTimeout(function () {
        if (isOpen) return;
        $('.tt').textContent = cfg.greeting.length > 120 ? cfg.greeting.slice(0, 117) + '…' : cfg.greeting;
        teaser.hidden = false;
        try {
          sessionStorage.setItem(STORE + '_t', '1');
        } catch (e) {}
      }, 4000);
    }
    if (attr('open') === 'true' && window.innerWidth > 480) open();

    var apiObj = { open: open, close: close, toggle: function () { isOpen ? close() : open(); }, send: send };
    window.ChatAgents = window.ChatAgents || {};
    window.ChatAgents[agentId] = apiObj;
    window.ChatAgent = apiObj;
  }

  function start() {
    fetch(API + '/config', { credentials: 'omit' })
      .then(function (r) {
        return r.json().then(function (d) {
          if (!r.ok) throw new Error((d && d.error && d.error.message) || 'HTTP ' + r.status);
          return d;
        });
      })
      .then(boot)
      .catch(function (e) {
        loaded[agentId] = false;
        console.warn('[chat] The chat assistant did not load: ' + e.message);
      });
  }
  if (document.body) start();
  else document.addEventListener('DOMContentLoaded', start);
})();
