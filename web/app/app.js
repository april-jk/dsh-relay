"use strict";

const elements = Object.fromEntries(
  [
    "loading", "auth", "dashboard", "logout", "auth-form", "login-mode",
    "register-mode", "auth-submit", "auth-error", "email", "password",
    "show-pair", "pair-dialog", "pair-form", "close-pair", "pair-link",
    "pair-error", "pair-notice", "device-list", "empty-devices",
  ].map((id) => [id, document.getElementById(id)]),
);

let authMode = "login";
let pendingPair = parsePairValue(location.href);

function showOnly(id) {
  for (const name of ["loading", "auth", "dashboard"]) elements[name].classList.toggle("hidden", name !== id);
  elements.logout.classList.toggle("hidden", id !== "dashboard");
}

function errorMessage(code) {
  return {
    invalid_credentials: "邮箱或密码不正确。",
    email_exists: "这个邮箱已经注册，请直接登录。",
    invalid_or_expired_code: "配对链接已使用或已过期，请在电脑上重新生成。",
    device_offline: "电脑当前离线。",
    dsh_offline: "电脑在线，但 DSH 尚未启动。",
    e2ee_required: "这台电脑需要重新配对才能建立加密连接。",
    rate_limited: "请求过于频繁，请稍后重试。",
  }[code] || "操作没有完成，请重试。";
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    credentials: "same-origin",
    ...options,
    headers: options.body ? { "content-type": "application/json", ...(options.headers || {}) } : options.headers,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(errorMessage(data.error || data.reason));
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

function validatePair(code, key, relay) {
  if (!/^\d{6}$/.test(String(code || ""))) throw new Error("invalid code");
  DshCrypto.fromBase64Url(key, 32);
  if (relay && new URL(relay).origin !== location.origin) throw new Error("relay mismatch");
  return { code: String(code), key };
}

async function claimPair(pair) {
  await DshKeyStore.set(`pending:${pair.code}`, pair.key);
  const result = await api("/pair/claim", { method: "POST", body: JSON.stringify({ code: pair.code }) });
  await DshKeyStore.set(result.deviceId, pair.key);
  await DshKeyStore.remove(`pending:${pair.code}`);
  history.replaceState(null, "", "/app/");
  pendingPair = null;
  elements["pair-notice"].textContent = "电脑已绑定。现在可以建立端到端加密连接。";
  elements["pair-notice"].classList.remove("hidden");
  return result.deviceId;
}

function setAuthMode(mode) {
  authMode = mode;
  const login = mode === "login";
  elements["login-mode"].classList.toggle("active", login);
  elements["register-mode"].classList.toggle("active", !login);
  elements["login-mode"].setAttribute("aria-selected", String(login));
  elements["register-mode"].setAttribute("aria-selected", String(!login));
  elements.password.autocomplete = login ? "current-password" : "new-password";
  elements["auth-submit"].textContent = login ? "登录" : "创建账号";
  elements["auth-error"].textContent = "";
}

function deviceStatus(device) {
  if (!device.online) return { label: "电脑离线", className: "status-offline" };
  if (device.dshStatus !== "online") return { label: "等待 DSH", className: "status-offline" };
  return { label: "可以连接", className: "status-online" };
}

async function renderDevices(data) {
  data ||= await api("/devices");
  elements["device-list"].replaceChildren();
  elements["empty-devices"].classList.toggle("hidden", data.devices.length !== 0);
  for (const device of data.devices) {
    const status = deviceStatus(device);
    const article = document.createElement("article");
    article.className = "device-item";
    const info = document.createElement("div");
    const name = document.createElement("h2");
    name.textContent = device.name;
    const meta = document.createElement("div");
    meta.className = "device-meta";
    const state = document.createElement("span");
    state.className = status.className;
    state.textContent = status.label;
    const seen = document.createElement("span");
    seen.textContent = device.lastSeenAt ? `最近连接 ${new Date(device.lastSeenAt).toLocaleString()}` : "尚未连接";
    meta.append(state, seen);
    info.append(name, meta);
    const actions = document.createElement("div");
    actions.className = "device-actions";
    const open = document.createElement("button");
    open.className = "primary-button";
    open.type = "button";
    open.textContent = "打开 DSH";
    open.disabled = !device.online || device.dshStatus !== "online";
    open.addEventListener("click", () => openRemote(device, open));
    const remove = document.createElement("button");
    remove.className = "quiet-button";
    remove.type = "button";
    remove.textContent = "移除";
    remove.addEventListener("click", () => removeDevice(device));
    actions.append(open, remove);
    article.append(info, actions);
    elements["device-list"].append(article);
  }
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
  if (!("serviceWorker" in navigator) || !crypto.subtle) throw new Error("当前浏览器不支持安全远程访问，请升级 Safari。");
  await navigator.serviceWorker.register("/app/sw.js", { scope: "/" });
  await navigator.serviceWorker.ready;
  if (navigator.serviceWorker.controller) return navigator.serviceWorker.controller;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("安全连接组件启动超时。")), 5000);
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      clearTimeout(timer);
      resolve(navigator.serviceWorker.controller);
    }, { once: true });
  });
}

function initializeTunnel(worker, options) {
  return new Promise((resolve, reject) => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => reject(new Error("加密连接启动超时。")), 15000);
    channel.port1.onmessage = (event) => {
      clearTimeout(timer);
      event.data?.ok ? resolve() : reject(new Error(event.data?.error || "无法建立加密连接。"));
    };
    worker.postMessage({ type: "init-tunnel", ...options }, [channel.port2]);
  });
}

async function openRemote(device, button) {
  const original = button.textContent;
  button.disabled = true;
  button.textContent = "正在加密连接";
  try {
    const masterKey = await DshKeyStore.get(device.id);
    if (!masterKey) throw new Error("此浏览器没有这台电脑的加密密钥，请重新配对。 ");
    const ticket = await api("/web-ticket", { method: "POST", body: JSON.stringify({ deviceId: device.id }) });
    const worker = await ensureWorker();
    await initializeTunnel(worker, {
      deviceId: device.id,
      accessSessionId: ticket.accessSessionId,
      tunnelUrl: ticket.tunnelUrl,
      ticket: ticket.ticket,
      masterKey,
    });
    location.assign(`/remote/${encodeURIComponent(device.id)}/`);
  } catch (error) {
    elements["pair-notice"].textContent = error.message;
    elements["pair-notice"].classList.remove("hidden");
    button.disabled = false;
    button.textContent = original;
  }
}

async function removeDevice(device) {
  if (!confirm(`确定移除“${device.name}”吗？这台电脑需要重新配对才能访问。`)) return;
  await api(`/devices/${encodeURIComponent(device.id)}`, { method: "DELETE", body: "{}" });
  await DshKeyStore.remove(device.id);
  await renderDevices();
}

async function enterDashboard() {
  showOnly("dashboard");
  if (pendingPair) {
    try {
      const deviceId = await claimPair(pendingPair);
      await waitForDevice(deviceId);
    } catch (error) {
      elements["pair-notice"].textContent = error.message;
      elements["pair-notice"].classList.remove("hidden");
    }
  }
  await renderDevices();
}

elements["auth-form"].addEventListener("submit", async (event) => {
  event.preventDefault();
  elements["auth-error"].textContent = "";
  elements["auth-submit"].disabled = true;
  try {
    await api(`/web-auth/${authMode}`, {
      method: "POST",
      body: JSON.stringify({ email: elements.email.value, password: elements.password.value }),
    });
    await enterDashboard();
  } catch (error) {
    elements["auth-error"].textContent = error.message;
  } finally {
    elements["auth-submit"].disabled = false;
  }
});

elements["login-mode"].addEventListener("click", () => setAuthMode("login"));
elements["register-mode"].addEventListener("click", () => setAuthMode("register"));
elements.logout.addEventListener("click", async () => {
  await api("/web-auth/logout", { method: "POST", body: "{}" });
  showOnly("auth");
});
elements["show-pair"].addEventListener("click", () => elements["pair-dialog"].showModal());
for (const trigger of document.querySelectorAll(".pair-trigger")) trigger.addEventListener("click", () => elements["pair-dialog"].showModal());
elements["close-pair"].addEventListener("click", () => elements["pair-dialog"].close());
elements["pair-form"].addEventListener("submit", async (event) => {
  event.preventDefault();
  elements["pair-error"].textContent = "";
  const pair = parsePairValue(elements["pair-link"].value);
  if (!pair) {
    elements["pair-error"].textContent = "请输入电脑生成的完整配对链接。";
    return;
  }
  try {
    const deviceId = await claimPair(pair);
    elements["pair-dialog"].close();
    elements["pair-link"].value = "";
    await waitForDevice(deviceId);
  } catch (error) {
    elements["pair-error"].textContent = error.message;
  }
});

(async function start() {
  try {
    const session = await api("/web-auth/session");
    if (session.authenticated) await enterDashboard();
    else showOnly("auth");
  } catch {
    showOnly("auth");
  }
})();
