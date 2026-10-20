"use strict";

const elements = Object.fromEntries(
  [
    "loading", "auth", "dashboard", "connecting", "topbar", "logout",
    "auth-form", "login-mode", "register-mode", "auth-submit", "auth-error",
    "auth-title", "auth-description", "email", "password", "toggle-password",
    "show-pair", "pair-dialog", "pair-form", "close-pair", "pair-link",
    "pair-error", "pair-notice", "device-list", "empty-devices", "scan-mode",
    "manual-mode", "scan-panel", "manual-panel", "pair-camera", "camera-loading",
    "camera-status", "camera-retry", "pair-link-field", "manual-submit",
    "show-settings", "settings-dialog", "close-settings", "settings-email",
    "settings-relay", "relay-host", "connecting-device", "cancel-connecting",
  ].map((id) => [id, document.getElementById(id)]),
);

const { t } = DshI18n;
let deviceData = null;
let connectingName = "";
let authMode = "login";
let pendingPair = parsePairValue(location.href);
let pendingBrowserPair = parseBrowserPairValue(location.href);
let signedInEmail = "";
let connectionCancelled = false;
let pairMode = "scan";
let pairScanner = null;
let pairSubmitting = false;

const computerIcon = '<svg aria-hidden="true" viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8M12 17v4"/></svg>';

function showOnly(id) {
  for (const name of ["loading", "auth", "dashboard", "connecting"]) {
    elements[name].classList.toggle("hidden", name !== id);
  }
  elements.topbar.classList.toggle("hidden", id !== "dashboard");
  document.body.dataset.view = id;
}

function localizedText(node, key, values) {
  DshI18n.text(node, key, values);
}

function showError(node, error, fallback) {
  localizedText(node, DshI18n.error(error, fallback));
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    credentials: "same-origin",
    ...options,
    headers: options.body ? { "content-type": "application/json", ...(options.headers || {}) } : options.headers,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || data.reason || "request_failed");
    error.code = data.error || data.reason;
    throw error;
  }
  return data;
}

function parsePairValue(value) {
  try {
    const trimmed = String(value || "").trim();
    if (trimmed.startsWith("{")) {
      const parsed = JSON.parse(trimmed);
      return validatePair(parsed.code, parsed.e2eeKey, parsed.relay);
    }
    const url = new URL(trimmed, location.href);
    const query = url.hash.includes("?") ? url.hash.slice(url.hash.indexOf("?") + 1) : url.search.slice(1);
    const params = new URLSearchParams(query);
    return validatePair(params.get("code"), params.get("key") || params.get("e2eeKey"), url.origin);
  } catch {
    return null;
  }
}

function parsePairInput(value) {
  const browser = parseBrowserPairValue(value);
  return browser ? { kind: "browser", ...browser } : (() => {
    const pair = parsePairValue(value);
    return pair ? { kind: "computer", ...pair } : null;
  })();
}

function validatePair(code, key, relay) {
  if (!/^\d{6}$/.test(String(code || ""))) throw new Error("invalid code");
  DshCrypto.fromBase64Url(key, 32);
  if (relay && new URL(relay).origin !== location.origin) throw new Error("relay mismatch");
  return { code: String(code), key };
}

function parseBrowserPairValue(value) {
  try {
    const url = new URL(String(value || "").trim(), location.href);
    const query = url.hash.startsWith("#/web-pair?")
      ? url.hash.slice("#/web-pair?".length)
      : "";
    const params = new URLSearchParams(query);
    const deviceId = params.get("device");
    const key = params.get("key");
    if (!/^dev_[A-Za-z0-9_-]+$/.test(deviceId || "")) throw new Error("invalid device");
    DshCrypto.fromBase64Url(key, 32);
    if (url.origin !== location.origin) throw new Error("relay mismatch");
    return { deviceId, key };
  } catch {
    return null;
  }
}

async function claimPair(pair) {
  await DshKeyStore.set(`pending:${pair.code}`, pair.key);
  const result = await api("/pair/claim", { method: "POST", body: JSON.stringify({ code: pair.code }) });
  await DshKeyStore.set(result.deviceId, pair.key);
  await DshKeyStore.remove(`pending:${pair.code}`);
  history.replaceState(null, "", "/app/");
  pendingPair = null;
  localizedText(elements["pair-notice"], "paired");
  elements["pair-notice"].classList.remove("hidden");
  return result.deviceId;
}

async function enrollBrowserPair(pair) {
  // Keep the key only in memory while authorization is checked. It must not
  // remain in browser history when enrollment fails or targets another account.
  history.replaceState(null, "", "/app/");
  const data = await api("/devices");
  const device = data.devices.find((item) => item.id === pair.deviceId);
  if (!device) throw new Error("wrongAccount");
  await DshKeyStore.set(pair.deviceId, pair.key);
  pendingBrowserPair = null;
  localizedText(elements["pair-notice"], "browserEnabled", { name: device.name });
  elements["pair-notice"].classList.remove("hidden");
  return pair.deviceId;
}

function setAuthMode(mode) {
  authMode = mode;
  const login = mode === "login";
  elements["login-mode"].classList.toggle("active", login);
  elements["register-mode"].classList.toggle("active", !login);
  elements["login-mode"].setAttribute("aria-selected", String(login));
  elements["register-mode"].setAttribute("aria-selected", String(!login));
  elements.password.autocomplete = login ? "current-password" : "new-password";
  localizedText(elements["auth-submit"], login ? "login" : "createAccount");
  localizedText(elements["auth-title"], login ? "connectTitle" : "createAccount");
  localizedText(elements["auth-description"], login ? "loginDescription" : "registerDescription");
  elements["auth-error"].textContent = "";
  delete elements["auth-error"].dataset.i18n;
}

function deviceStatus(device) {
  if (!device.online) return { label: t("offlineStatus"), className: "status-offline" };
  if (device.dshStatus !== "online") return { label: t("dshStopped"), className: "status-warning" };
  return { label: t("online"), className: "status-online" };
}

function lastSeen(value) {
  if (!value) return "";
  const time = new Date(value);
  const elapsed = Math.max(0, Date.now() - time.getTime());
  if (elapsed < 60_000) return t("justNow");
  if (elapsed < 3_600_000) return t("minutesAgo", { count: Math.floor(elapsed / 60_000) });
  if (elapsed < 86_400_000) return t("hoursAgo", { count: Math.floor(elapsed / 3_600_000) });
  return new Intl.DateTimeFormat(DshI18n.locale, { month: "short", day: "numeric" }).format(time);
}

function closeDeviceMenus(except) {
  for (const menu of document.querySelectorAll(".device-menu-popover")) {
    if (menu !== except) menu.classList.add("hidden");
  }
}

async function renameDevice(device) {
  const name = prompt(t("computerName"), device.name)?.trim();
  if (!name || name === device.name) return;
  await api(`/devices/${encodeURIComponent(device.id)}`, {
    method: "PATCH",
    body: JSON.stringify({ name: name.slice(0, 60) }),
  });
  await renderDevices();
}

async function renderDevices(data) {
  data ||= await api("/devices");
  deviceData = data;
  elements["device-list"].replaceChildren();
  elements["empty-devices"].classList.toggle("hidden", data.devices.length !== 0);
  for (const device of data.devices) {
    const status = deviceStatus(device);
    const article = document.createElement("article");
    article.className = "device-item";

    const open = document.createElement("button");
    open.className = "device-open";
    open.type = "button";
    open.disabled = !device.online || device.dshStatus !== "online";
    open.setAttribute("aria-label", t("openDevice", { name: device.name }));

    const icon = document.createElement("span");
    icon.className = "device-icon";
    icon.innerHTML = computerIcon;
    const copy = document.createElement("span");
    copy.className = "device-copy";
    const name = document.createElement("h2");
    name.textContent = device.name;
    const meta = document.createElement("span");
    meta.className = `device-meta ${status.className}`;
    const dot = document.createElement("span");
    dot.className = "status-dot";
    const state = document.createElement("span");
    state.className = "status-label";
    state.textContent = status.label;
    meta.append(dot, state);
    const seenText = lastSeen(device.lastSeenAt);
    if (seenText) {
      const seen = document.createElement("span");
      seen.className = "last-seen";
      seen.textContent = seenText;
      meta.append(seen);
    }
    copy.append(name, meta);
    open.append(icon, copy);
    open.addEventListener("click", () => openRemote(device));

    const menu = document.createElement("div");
    menu.className = "device-menu";
    const menuButton = document.createElement("button");
    menuButton.className = "icon-button";
    menuButton.type = "button";
    menuButton.textContent = "⋮";
    menuButton.setAttribute("aria-label", t("deviceMenu", { name: device.name }));
    menuButton.setAttribute("aria-expanded", "false");
    const popover = document.createElement("div");
    popover.className = "device-menu-popover hidden";
    const rename = document.createElement("button");
    rename.type = "button";
    rename.textContent = t("rename");
    rename.addEventListener("click", () => renameDevice(device).catch(showNotice));
    const remove = document.createElement("button");
    remove.className = "remove-action";
    remove.type = "button";
    remove.textContent = t("removePair");
    remove.addEventListener("click", () => removeDevice(device).catch(showNotice));
    popover.append(rename, remove);
    menuButton.addEventListener("click", () => {
      const willOpen = popover.classList.contains("hidden");
      closeDeviceMenus(popover);
      popover.classList.toggle("hidden", !willOpen);
      menuButton.setAttribute("aria-expanded", String(willOpen));
    });
    menu.append(menuButton, popover);
    article.append(open, menu);
    elements["device-list"].append(article);
  }
}

function showNotice(error) {
  showError(elements["pair-notice"], error);
  elements["pair-notice"].classList.remove("hidden");
}

function setCameraStatus(message, error = false) {
  localizedText(elements["camera-status"], message);
  elements["camera-status"].classList.toggle("error", error);
  elements["camera-retry"].classList.toggle("hidden", !error);
}

function stopPairScanner() {
  pairScanner?.stop();
  elements["camera-loading"].classList.add("hidden");
}

async function startPairScanner() {
  if (pairMode !== "scan" || !elements["pair-dialog"].open) return;
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    setCameraStatus("cameraHttps", true);
    return;
  }
  if (!window.QrScanner) {
    setCameraStatus("scannerMissing", true);
    return;
  }
  elements["camera-loading"].classList.remove("hidden");
  setCameraStatus("cameraRequest");
  try {
    if (!pairScanner) {
      QrScanner.WORKER_PATH = "/app/qr-scanner-worker.min.js";
      pairScanner = new QrScanner(
        elements["pair-camera"],
        (result) => handleScannedPair(result?.data || result),
        { preferredCamera: "environment", highlightScanRegion: false, highlightCodeOutline: false },
      );
    }
    // Do not run the library's separate camera availability probe here. It opens a separate permission/
    // enumeration request and can remain pending on Android until the browser
    // finishes its permission UI. Starting the scanner uses the same stream and
    // gives us a bounded failure path.
    let timeoutId;
    try {
      await Promise.race([
        pairScanner.start(),
        new Promise((_, reject) => {
          timeoutId = setTimeout(() => reject(new Error("cameraTimeout")), 12_000);
        }),
      ]);
    } finally {
      clearTimeout(timeoutId);
    }
    elements["camera-loading"].classList.add("hidden");
    setCameraStatus("cameraHelp");
  } catch (error) {
    stopPairScanner();
    elements["camera-loading"].classList.add("hidden");
    const message = error?.name === "NotAllowedError"
      ? "cameraDenied"
      : DshI18n.error(error, "cameraFailed");
    setCameraStatus(message, true);
  }
}

function setPairMode(mode) {
  pairMode = mode;
  const scan = mode === "scan";
  elements["scan-mode"].classList.toggle("active", scan);
  elements["manual-mode"].classList.toggle("active", !scan);
  elements["scan-mode"].setAttribute("aria-selected", String(scan));
  elements["manual-mode"].setAttribute("aria-selected", String(!scan));
  elements["scan-panel"].classList.toggle("hidden", !scan);
  elements["manual-panel"].classList.toggle("hidden", scan);
  elements["pair-link-field"].classList.toggle("hidden", scan);
  elements["manual-submit"].classList.toggle("hidden", scan);
  elements["pair-link"].required = !scan;
  if (scan) startPairScanner();
  else stopPairScanner();
}

async function submitPairValue(raw) {
  const parsed = parsePairInput(raw);
  if (!parsed) throw new Error("invalidPair");
  pairSubmitting = true;
  elements["pair-error"].textContent = "";
  delete elements["pair-error"].dataset.i18n;
  stopPairScanner();
  try {
    const deviceId = parsed.kind === "browser"
      ? await enrollBrowserPair(parsed)
      : await claimPair(parsed);
    elements["pair-dialog"].close();
    elements["pair-link"].value = "";
    if (parsed.kind === "computer") await waitForDevice(deviceId);
    else await renderDevices();
  } finally {
    pairSubmitting = false;
  }
}

function handleScannedPair(raw) {
  if (pairSubmitting || !raw) return;
  submitPairValue(raw).catch((error) => {
    pairSubmitting = false;
    showError(elements["pair-error"], error);
    setCameraStatus("scanInvalid", true);
    if (elements["pair-dialog"].open) startPairScanner();
  });
}

async function waitForDevice(deviceId) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const data = await api("/devices");
    await renderDevices(data);
    if (data.devices.some((device) => device.id === deviceId)) return;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

async function ensureWorker() {
  if (!("serviceWorker" in navigator) || !crypto.subtle) throw new Error("unsupportedBrowser");
  await navigator.serviceWorker.register("/app/sw.js?v=0.1.9", { scope: "/" });
  await navigator.serviceWorker.ready;
  if (navigator.serviceWorker.controller) return navigator.serviceWorker.controller;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("workerTimeout")), 5000);
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      clearTimeout(timer);
      resolve(navigator.serviceWorker.controller);
    }, { once: true });
  });
}

function initializeTunnel(worker, options) {
  return new Promise((resolve, reject) => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => reject(new Error("connectTimeout")), 15000);
    channel.port1.onmessage = (event) => {
      clearTimeout(timer);
      event.data?.ok ? resolve() : reject(new Error(event.data?.error || "connectFailed"));
    };
    worker.postMessage({ type: "init-tunnel", ...options }, [channel.port2]);
  });
}

async function openRemote(device) {
  connectionCancelled = false;
  connectingName = device.name;
  localizedText(elements["connecting-device"], "connectingDevice", { name: device.name });
  showOnly("connecting");
  try {
    const masterKey = await DshKeyStore.get(device.id);
    if (!masterKey) throw new Error("missingKey");
    const ticket = await api("/web-ticket", { method: "POST", body: JSON.stringify({ deviceId: device.id }) });
    const worker = await ensureWorker();
    await initializeTunnel(worker, {
      deviceId: device.id,
      accessSessionId: ticket.accessSessionId,
      tunnelUrl: ticket.tunnelUrl,
      ticket: ticket.ticket,
      masterKey,
      locale: DshI18n.locale,
    });
    if (!connectionCancelled) location.assign(`/remote/${encodeURIComponent(device.id)}/`);
  } catch (error) {
    showOnly("dashboard");
    showNotice(error);
  }
}

async function removeDevice(device) {
  closeDeviceMenus();
  if (!confirm(t("removeConfirm", { name: device.name }))) return;
  await api(`/devices/${encodeURIComponent(device.id)}`, { method: "DELETE", body: "{}" });
  await DshKeyStore.remove(device.id);
  await renderDevices();
}

async function enterDashboard() {
  showOnly("dashboard");
  // Re-read the fragment after dependencies and authentication are ready.
  // This also recovers from a cached page that initialized before the URL was
  // updated by an external QR/link handoff.
  pendingBrowserPair = pendingBrowserPair || parseBrowserPairValue(location.href);
  if (pendingBrowserPair) {
    try {
      await enrollBrowserPair(pendingBrowserPair);
    } catch (error) {
      showNotice(error);
      pendingBrowserPair = null;
    }
  }
  if (pendingPair) {
    try {
      const deviceId = await claimPair(pendingPair);
      await waitForDevice(deviceId);
    } catch (error) {
      showNotice(error);
    }
  }
  await renderDevices();
}

function updateAccountDetails(email) {
  signedInEmail = email || signedInEmail;
  elements["settings-email"].textContent = signedInEmail || t("signedIn");
  elements["settings-relay"].textContent = location.origin;
}

elements["auth-form"].addEventListener("submit", async (event) => {
  event.preventDefault();
  elements["auth-error"].textContent = "";
  delete elements["auth-error"].dataset.i18n;
  elements["auth-submit"].disabled = true;
  localizedText(elements["auth-submit"], authMode === "login" ? "loggingIn" : "creating");
  try {
    await api(`/web-auth/${authMode}`, {
      method: "POST",
      body: JSON.stringify({ email: elements.email.value, password: elements.password.value }),
    });
    updateAccountDetails(elements.email.value.trim().toLowerCase());
    await enterDashboard();
  } catch (error) {
    showError(elements["auth-error"], error);
  } finally {
    elements["auth-submit"].disabled = false;
    localizedText(elements["auth-submit"], authMode === "login" ? "login" : "createAccount");
  }
});

elements["login-mode"].addEventListener("click", () => setAuthMode("login"));
elements["register-mode"].addEventListener("click", () => setAuthMode("register"));
elements["toggle-password"].addEventListener("click", () => {
  const revealing = elements.password.type === "password";
  elements.password.type = revealing ? "text" : "password";
  const key = revealing ? "hidePassword" : "showPassword";
  elements["toggle-password"].dataset.i18nAriaLabel = key;
  elements["toggle-password"].dataset.i18nTitle = key;
  DshI18n.apply();
});
elements.logout.addEventListener("click", async () => {
  try {
    await api("/web-auth/logout", { method: "POST", body: "{}" });
  } catch (error) { showNotice(error); return; }
  elements["settings-dialog"].close();
  elements.password.value = "";
  signedInEmail = "";
  showOnly("auth");
});
function openPairDialog() {
  elements["pair-error"].textContent = "";
  delete elements["pair-error"].dataset.i18n;
  elements["pair-dialog"].showModal();
  setPairMode("scan");
}

function closePairDialog() {
  stopPairScanner();
  elements["pair-dialog"].close();
}

elements["show-pair"].addEventListener("click", openPairDialog);
for (const trigger of document.querySelectorAll(".pair-trigger")) trigger.addEventListener("click", openPairDialog);
elements["close-pair"].addEventListener("click", closePairDialog);
elements["pair-dialog"].addEventListener("close", stopPairScanner);
elements["scan-mode"].addEventListener("click", () => setPairMode("scan"));
elements["manual-mode"].addEventListener("click", () => setPairMode("manual"));
elements["camera-retry"].addEventListener("click", () => startPairScanner());
elements["show-settings"].addEventListener("click", () => elements["settings-dialog"].showModal());
elements["close-settings"].addEventListener("click", () => elements["settings-dialog"].close());
elements["cancel-connecting"].addEventListener("click", () => {
  connectionCancelled = true;
  showOnly("dashboard");
});
document.addEventListener("click", (event) => {
  if (!event.target.closest(".device-menu")) closeDeviceMenus();
});
elements["pair-form"].addEventListener("submit", async (event) => {
  event.preventDefault();
  if (pairMode !== "manual" || pairSubmitting) return;
  elements["pair-error"].textContent = "";
  delete elements["pair-error"].dataset.i18n;
  try {
    await submitPairValue(elements["pair-link"].value);
  } catch (error) {
    showError(elements["pair-error"], error);
  }
});

window.addEventListener("dsh-language-change", () => {
  if (!elements["auth-submit"].disabled) {
    localizedText(elements["auth-submit"], authMode === "login" ? "login" : "createAccount");
  }
  updateAccountDetails();
  if (deviceData) renderDevices(deviceData);
  if (connectingName) localizedText(elements["connecting-device"], "connectingDevice", { name: connectingName });
});

(async function start() {
  elements["relay-host"].textContent = location.host;
  elements["settings-relay"].textContent = location.origin;
  try {
    const session = await api("/web-auth/session");
    if (session.authenticated) {
      updateAccountDetails(session.email);
      await enterDashboard();
    } else {
      showOnly("auth");
    }
  } catch {
    showOnly("auth");
  }
})();
