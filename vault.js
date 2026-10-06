/* Lock screen of the published (encrypted) dashboard.
 *
 * keys.json: {v, kdf: {alg: "argon2id", m, t, p, len, salt}, wraps: [...], data: "<file id>"}
 * vault/<id>.bin: nonce (12 bytes) || AES-256-GCM ciphertext+tag, file id as associated data.
 *
 * passphrase --Argon2id (hash-wasm)--> key that unwraps the data key --> decrypt the
 * dashboard data --> start app.js. Photos and videos are decrypted on demand into
 * blob: URLs (window.EXPLORATION_VAULT.url). Nothing is decrypted before the
 * passphrase is right; nothing leaves the browser.
 *
 * Written by strava_code.deploy; see strava_code/deploy/vault.py for the other side.
 */
"use strict";
(() => {
  const te = new TextEncoder(), td = new TextDecoder();
  const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
  const b64 = u8 => btoa(String.fromCharCode(...u8));
  const WRAP_AAD = te.encode("exploration:data-key:v1");
  const SESSION = "exploration.unlocked";
  const session = {
    get: () => { try { return sessionStorage.getItem(SESSION); } catch { return null; } },
    set: v => { try { sessionStorage.setItem(SESSION, v); } catch { /* private mode */ } },
    clear: () => { try { sessionStorage.removeItem(SESSION); } catch { /* private mode */ } },
  };

  const aesKey = raw => crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["decrypt"]);
  async function decrypt(key, buffer, aad) {
    const u8 = new Uint8Array(buffer);
    return new Uint8Array(await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: u8.subarray(0, 12), additionalData: aad }, key, u8.subarray(12)));
  }
  async function fetchBytes(path) {
    const r = await fetch(path, { cache: "no-store" });
    if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
    return r.arrayBuffer();
  }
  let keysPromise = null;
  const keys = () => (keysPromise ??= fetch("keys.json", { cache: "no-store" }).then(r => {
    if (!r.ok) throw new Error(`keys.json: HTTP ${r.status}`);
    return r.json();
  }));

  /** The data key for this passphrase, or null if it opens none of the wraps. */
  async function unwrap(passphrase) {
    const k = await keys();
    const kek = await hashwasm.argon2id({
      password: passphrase.normalize("NFC").trim(), salt: unb64(k.kdf.salt),
      parallelism: k.kdf.p, iterations: k.kdf.t, memorySize: k.kdf.m, hashLength: k.kdf.len, outputType: "binary" });
    const wrapKey = await aesKey(kek);
    for (const w of k.wraps) {
      try { return await decrypt(wrapKey, unb64(w), WRAP_AAD); } catch { /* another viewer's wrap */ }
    }
    return null;
  }

  async function start(rawKey) {
    const k = await keys();
    const key = await aesKey(rawKey);
    const payload = JSON.parse(td.decode(await decrypt(key, await fetchBytes(`vault/${k.data}.bin`), te.encode(k.data))));
    const urls = new Map();
    window.EXPLORATION = payload.dashboard;
    window.EXPLORATION_CONFIG = payload.config;
    window.EXPLORATION_VAULT = {
      /** blob: URL of a published photo / video (decrypted once, then cached). */
      url(path) {
        if (!urls.has(path)) urls.set(path, (async () => {
          const id = payload.files[path];
          if (!id) throw new Error("not published");
          const bytes = await decrypt(key, await fetchBytes(`vault/${id}.bin`), te.encode(id));
          return URL.createObjectURL(new Blob([bytes], { type: payload.types[path] || "application/octet-stream" }));
        })());
        return urls.get(path);
      },
    };
    maplibregl.setWorkerUrl("lib/maplibre-gl-csp-worker.js");
    document.getElementById("lock")?.remove();
    document.documentElement.classList.remove("locked");
    const lockBtn = el("button", { class: "lock-btn", type: "button", title: "Lock: forget the key in this tab" }, "Lock");
    lockBtn.addEventListener("click", () => { session.clear(); location.reload(); });
    document.querySelector(".top")?.append(lockBtn);
    const app = document.createElement("script");
    app.src = "app.js";
    document.body.append(app);
  }

  function el(tag, attrs = {}, ...children) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    n.append(...children);
    return n;
  }

  function showLock(message = "") {
    const input = el("input", { type: "password", id: "lock-pass", autocomplete: "current-password",
                                spellcheck: "false", "aria-describedby": "lock-status", required: "" });
    const remember = el("input", { type: "checkbox", id: "lock-remember", checked: "" });
    const button = el("button", { type: "submit" }, "Unlock");
    const status = el("p", { id: "lock-status", class: "lock-status", role: "status" }, message);
    const form = el("form", { class: "lock-card", autocomplete: "on" },
      el("h1", {}, "Exploration"),
      el("p", { class: "lock-sub" }, "Private dashboard. Enter your passphrase."),
      el("label", { for: "lock-pass", class: "lock-label" }, "Passphrase"), input,
      el("label", { class: "lock-remember" }, remember, " Stay unlocked in this tab"),
      button, status);
    form.addEventListener("submit", async e => {
      e.preventDefault();
      button.disabled = input.disabled = true;
      status.className = "lock-status";
      status.textContent = "Unlocking…";
      try {
        const raw = await unwrap(input.value);
        if (!raw) {
          status.className = "lock-status error";
          status.textContent = "Wrong passphrase.";
          button.disabled = input.disabled = false;
          input.select();
          return;
        }
        if (remember.checked) session.set(b64(raw));
        await start(raw);
      } catch (err) {
        status.className = "lock-status error";
        status.textContent = location.protocol === "file:"
          ? "Open this site through a web server (https://… or python -m http.server), not as a file."
          : `Could not load the dashboard (${err.message}).`;
        button.disabled = input.disabled = false;
      }
    });
    (document.querySelector(".viz-root") || document.body).append(el("div", { id: "lock", class: "lock" }, form));
    input.focus();
  }

  async function boot() {
    const saved = session.get();
    if (saved) {
      try { await start(unb64(saved)); return; } catch { session.clear(); }   // e.g. the site was republished
    }
    showLock();
  }
  boot();
})();
