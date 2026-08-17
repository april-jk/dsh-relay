"use strict";

const elements = Object.fromEntries(
  [
    "loading", "auth", "dashboard", "connecting", "topbar", "logout",
    "auth-form", "login-mode", "register-mode", "auth-submit", "auth-error",
    "auth-title", "auth-description", "email", "password", "toggle-password",
    "show-pair", "pair-dialog", "pair-form", "close-pair", "pair-link",
    "pair-error", "pair-notice", "device-list", "empty-devices",
    "show-settings", "settings-dialog", "close-settings", "settings-email",
    "settings-relay", "relay-host", "connecting-device", "cancel-connecting",
  ].map((id) => [id, document.getElementById(id)]),
);

let authMode = "login";
let pendingPair = parsePairValue(location.href);
let signedInEmail = "";
let connectionCancelled = false;

const computerIcon = '<svg aria-hidden="true" viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8M12 17v4"/></svg>';

function showOnly(id) {
  for (const name of ["loading", "auth", "dashboard", "connecting"]) {
    elements[name].classList.toggle("hidden", name !== id);
  }
  elements.topbar.classList.toggle("hidden", id !== "dashboard");
  document.body.dataset.view = id;
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
  elements["pair-notice"].textContent = "电脑已绑定，现在可以建立端到端加密连接。";
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
  elements["auth-title"].textContent = login ? "连接你的 DSH" : "创建账号";
  elements["auth-description"].textContent = login
    ? "登录后访问已绑定电脑上的 DeepSeek Harness。"
    : "注册后，用手机扫码绑定你的电脑。";
  elements["auth-error"].textContent = "";
}

function deviceStatus(device) {
  if (!device.online) return { label: "电脑离线", className: "status-offline" };
  if (device.dshStatus !== "online") return { label: "DSH 未启动", className: "status-warning" };
  return { label: "在线", className: "status-online" };
}

function lastSeen(value) {
  if (!value) return "";
  const time = new Date(value);
  const elapsed = Math.max(0, Date.now() - time.getTime());
  if (elapsed < 60_000) return "刚刚";
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)} 分钟前`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)} 小时前`;
  return `${time.getMonth() + 1} 月 ${time.getDate()} 日`;
}

function closeDeviceMenus(except) {
  for (const menu of document.querySelectorAll(".device-menu-popover")) {
    if (menu !== except) menu.classList.add("hidden");
  }
}

async function renameDevice(device) {
  const name = prompt("电脑名称", device.name)?.trim();
  if (!name || name === device.name) return;
  await api(`/devices/${encodeURIComponent(device.id)}`, {
    method: "PATCH",
    body: JSON.stringify({ name: name.slice(0, 60) }),
  });
  await renderDevices();
}

async function renderDevices(data) {
  data ||= await api("/devices");
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
    open.setAttribute("aria-label", `打开 ${device.name}`);

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
    menuButton.setAttribute("aria-label", `${device.name} 操作`);
    menuButton.setAttribute("aria-expanded", "false");
    const popover = document.createElement("div");
    popover.className = "device-menu-popover hidden";
    const rename = document.createElement("button");
    rename.type = "button";
    rename.textContent = "重命名";
    rename.addEventListener("click", () => renameDevice(device).catch(showNotice));
    const remove = document.createElement("button");
    remove.className = "remove-action";
    remove.type = "button";
    remove.textContent = "移除配对";
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
  elements["pair-notice"].textContent = error.message || String(error);
  elements["pair-notice"].classList.remove("hidden");
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

async function openRemote(device) {
  connectionCancelled = false;
  elements["connecting-device"].textContent = `正在安全连接 ${device.name}。`;
  showOnly("connecting");
  try {
    const masterKey = await DshKeyStore.get(device.id);
    if (!masterKey) throw new Error("此浏览器没有这台电脑的加密密钥，请重新配对。");
    const ticket = await api("/web-ticket", { method: "POST", body: JSON.stringify({ deviceId: device.id }) });
    const worker = await ensureWorker();
    await initializeTunnel(worker, {
      deviceId: device.id,
      accessSessionId: ticket.accessSessionId,
      tunnelUrl: ticket.tunnelUrl,
      ticket: ticket.ticket,
      masterKey,
    });
    if (!connectionCancelled) location.assign(`/remote/${encodeURIComponent(device.id)}/`);
  } catch (error) {
    showOnly("dashboard");
    showNotice(error);
  }
}

async function removeDevice(device) {
  closeDeviceMenus();
  if (!confirm(`确定移除“${device.name}”吗？移除后需要回到电脑前重新扫码。`)) return;
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
      showNotice(error);
    }
  }
  await renderDevices();
}

function updateAccountDetails(email) {
  signedInEmail = email || signedInEmail;
  elements["settings-email"].textContent = signedInEmail || "已登录";
  elements["settings-relay"].textContent = location.origin;
}

elements["auth-form"].addEventListener("submit", async (event) => {
  event.preventDefault();
  elements["auth-error"].textContent = "";
  elements["auth-submit"].disabled = true;
  const label = elements["auth-submit"].textContent;
  elements["auth-submit"].textContent = authMode === "login" ? "正在登录…" : "正在创建…";
  try {
    await api(`/web-auth/${authMode}`, {
      method: "POST",
      body: JSON.stringify({ email: elements.email.value, password: elements.password.value }),
    });
    updateAccountDetails(elements.email.value.trim().toLowerCase());
    await enterDashboard();
  } catch (error) {
    elements["auth-error"].textContent = error.message;
  } finally {
    elements["auth-submit"].disabled = false;
    elements["auth-submit"].textContent = label;
  }
});

elements["login-mode"].addEventListener("click", () => setAuthMode("login"));
elements["register-mode"].addEventListener("click", () => setAuthMode("register"));
elements["toggle-password"].addEventListener("click", () => {
  const revealing = elements.password.type === "password";
  elements.password.type = revealing ? "text" : "password";
  elements["toggle-password"].setAttribute("aria-label", revealing ? "隐藏密码" : "显示密码");
  elements["toggle-password"].title = revealing ? "隐藏密码" : "显示密码";
});
elements.logout.addEventListener("click", async () => {
  await api("/web-auth/logout", { method: "POST", body: "{}" });
  elements["settings-dialog"].close();
  elements.password.value = "";
  signedInEmail = "";
  showOnly("auth");
});
elements["show-pair"].addEventListener("click", () => elements["pair-dialog"].showModal());
for (const trigger of document.querySelectorAll(".pair-trigger")) trigger.addEventListener("click", () => elements["pair-dialog"].showModal());
elements["close-pair"].addEventListener("click", () => elements["pair-dialog"].close());
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
