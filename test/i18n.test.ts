import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

function load(stored: string | null = null, languages = ["en-US"]) {
  const source = readFileSync("web/app/i18n.js", "utf8");
  const storage = new Map(stored ? [["dsh-relay-language", stored]] : []);
  const listeners = new Map<string, Set<Function>>();
  const classes: string[] = [];
  const nodes: any[] = [];
  const documentElement = { lang: "", classList: { add: (name: string) => classes.push(name), remove: () => {} } };
  const makeNode = (attributes: Record<string, string>) => {
    const node: any = { dataset: {}, attributes, textContent: "", setAttribute: (name: string, value: string) => { node.attributes[name] = value; }, getAttribute: (name: string) => node.attributes[name] ?? null };
    for (const [name, value] of Object.entries(attributes)) if (name.startsWith("data-i18n")) node.dataset[name.slice("data-i18n-".length) || "i18n"] = value;
    nodes.push(node);
    return node;
  };
  const selectListeners = new Map<string, Function>();
  const selects: any[] = [{ value: "", addEventListener: (name: string, callback: Function) => selectListeners.set(name, callback) }];
  const context: any = {
    localStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) },
    navigator: { languages, language: languages[0] },
    Event: class { type: string; constructor(type: string) { this.type = type; } },
    document: {
      documentElement,
      querySelectorAll: (selector: string) => selector === "[data-i18n]" ? nodes.filter(node => node.dataset.i18n) : selector === "[data-language-picker]" ? selects : [],
    },
    addEventListener: (type: string, callback: Function) => { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type)!.add(callback); },
    dispatchEvent: (event: any) => listeners.get(event.type)?.forEach(callback => callback(event)),
  };
  vm.runInNewContext(source, context);
  return { i18n: context.DshI18n, storage, nodes, selects, selectListeners, documentElement, context, makeNode };
}

test("every HTML localization key exists in all three catalogs", () => {
  const { i18n } = load();
  const catalogs = i18n.catalogs;
  const keys = Object.keys(catalogs.en).sort();
  for (const locale of ["en", "pl", "zh-CN"]) {
    assert.deepEqual(Object.keys(catalogs[locale]).sort(), keys, locale);
    for (const key of keys) {
      assert.ok(catalogs[locale][key].trim(), `${locale}.${key}`);
      const placeholders = (value: string) => [...value.matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort();
      assert.deepEqual(placeholders(catalogs[locale][key]), placeholders(catalogs.en[key]), `${locale}.${key}`);
    }
  }
  for (const file of ["web/app/index.html", "web/admin/index.html", "web/app/remote-unavailable.html"]) {
    const html = readFileSync(file, "utf8");
    for (const [, key] of html.matchAll(/data-i18n(?:-[a-z-]+)?="([^"]+)"/g)) {
      assert.ok(Object.hasOwn(catalogs.en, key), `${file} uses ${key}`);
    }
  }
});

test("locale resolves from storage, browser languages, and English fallback", () => {
  assert.equal(load(null, ["pl-PL"]).i18n.locale, "pl");
  assert.equal(load(null, ["zh-Hans-CN"]).i18n.locale, "zh-CN");
  assert.equal(load(null, ["de-DE", "cs-CZ"]).i18n.locale, "en");
  assert.equal(load("zh-CN", ["pl-PL"]).i18n.locale, "zh-CN");
  assert.equal(load("bogus", ["pl-PL"]).i18n.locale, "pl");
});

test("switching language updates document lang, text and persists the choice", () => {
  const runtime = load(null, ["en-US"]);
  const node = runtime.makeNode({ "data-i18n": "settings", "data-i18n-placeholder": "computerName" });
  runtime.context.document.querySelectorAll = (selector: string) =>
    selector === "[data-i18n]" ? [node] : selector === "[data-i18n-placeholder]" ? [node] : selector === "[data-language-picker]" ? [] : [];
  runtime.i18n.apply();
  const english = node.textContent;
  runtime.i18n.setLocale("pl");
  assert.equal(runtime.storage.get("dsh-relay-language"), "pl");
  assert.equal(runtime.documentElement.lang, "pl");
  assert.notEqual(node.textContent, english);
  assert.equal(node.textContent, runtime.i18n.catalogs.pl.settings);
  assert.equal(node.attributes.placeholder, runtime.i18n.catalogs.pl.computerName);
});

test("API error codes and known reason codes map to catalog keys, unknown falls back", () => {
  const { i18n } = load();
  assert.equal(i18n.error("invalid_credentials"), "invalid_credentials");
  assert.equal(i18n.error("e2ee_handshake_failed"), "e2ee_handshake_failed");
  assert.equal(i18n.error(new Error("handshakeTimeout")), "handshakeTimeout");
  assert.equal(i18n.error(new Error("something_unexpected")), "request_failed");
});


test("interpolation is text-only and language changes preserve user values", () => {
  const runtime = load();
  const node = runtime.makeNode({});
  const name = '<img src=x onerror=alert(1)> 中文 {count}';
  runtime.i18n.text(node, "browserEnabled", { name });
  runtime.i18n.setLocale("pl");
  assert.ok(node.textContent.includes(name));
  assert.equal(node.innerHTML, undefined);
  assert.equal(runtime.i18n.t("missing-key", {}, "unsupported"), runtime.i18n.catalogs.en.request_failed);
  assert.equal(runtime.i18n.error(new Error("arbitrary server content")), "request_failed");
});

test("blocked browser storage and worker-only contexts use deterministic fallback", () => {
  const source = readFileSync("web/app/i18n.js", "utf8");
  const context: any = { navigator: { language: "pl-PL" }, Event: class {}, localStorage: { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); } } };
  vm.runInNewContext(source, context);
  assert.equal(context.DshI18n.locale, "pl");
  assert.doesNotThrow(() => context.DshI18n.setLocale("zh-CN"));
  assert.equal(context.DshI18n.locale, "zh-CN");
  assert.equal(context.DshI18n.resolveLocale(null, ["de", "pl-PL", "zh"]), "pl");
});

test("language preference synchronizes across tabs without changing fragments", () => {
  const runtime = load();
  runtime.context.location = { hash: "#/pair?code=123456&key=secret" };
  runtime.context.dispatchEvent({ type: "storage", key: "dsh-relay-language", newValue: "pl" });
  assert.equal(runtime.i18n.locale, "pl");
  assert.equal(runtime.context.location.hash, "#/pair?code=123456&key=secret");
});

test("auth, camera, device and admin authored scripts use catalogs, not Chinese literals", () => {
  for (const file of ["web/app/app.js", "web/admin/admin.js", "web/app/sw.js"]) {
    assert.doesNotMatch(readFileSync(file, "utf8"), /[\p{Script=Han}]/u, file);
  }
  const app = readFileSync("web/app/app.js", "utf8");
  assert.match(app, /showError\(elements\["auth-error"\], error\)/);
  assert.match(app, /DshI18n.error\(error, "cameraFailed"\)/);
  assert.match(app, /name.textContent = device.name/);
  assert.match(app, /locale: DshI18n.locale/);
  assert.doesNotMatch(app, /error\.message\s*;/);
  for (const file of ["web/app/index.html", "web/admin/index.html", "web/app/remote-unavailable.html"]) {
    const html = readFileSync(file, "utf8");
    assert.match(html, /<html lang="en">/);
    assert.match(html, /<label for="relay-language"/);
    assert.match(html, /<select id="relay-language" data-language-picker>/);
    assert.match(html, /<script src="\/app\/i18n.js" defer><\/script>/);
    assert.doesNotMatch(html, /<script(?![^>]*src=)[^>]*>|\son\w+="/);
    assert.doesNotMatch(html.replace(/<option[^>]*>简体中文<\/option>/g, ""), /[\p{Script=Han}]/u);
  }
});

test("service-worker recovery assets bypass DSH and failures use per-tunnel locale", async () => {
  const listeners = new Map<string, Function>();
  const { i18n } = load();
  const context: any = {
    DshI18n: i18n, importScripts: () => {},
    indexedDB: { open: () => ({}) },
    TextEncoder, TextDecoder, URL, Response,
    self: { location: { origin: "https://relay.test" }, addEventListener: (name: string, callback: Function) => listeners.set(name, callback) },
  };
  vm.createContext(context);
  vm.runInContext(readFileSync("web/app/sw.js", "utf8"), context);
  vm.runInContext('remoteClients.set("remote", "dev_test"); tunnels.set("dev_test", { locale: "pl", request: () => Promise.reject(new Error("raw internal failure")) });', context);
  for (const path of ["/app/i18n.js", "/app/app.css", "/remote/unavailable.html"]) {
    let intercepted = false;
    listeners.get("fetch")!({ request: { url: `https://relay.test${path}`, headers: new Headers() }, clientId: "remote", respondWith: () => { intercepted = true; } });
    assert.equal(intercepted, false, path);
  }
  let result: Promise<Response> | undefined;
  listeners.get("fetch")!({ request: { url: "https://relay.test/remote/dev_test/", headers: new Headers() }, clientId: "remote", respondWith: (value: Promise<Response>) => { result = value; } });
  const response = await result!;
  assert.equal(response.status, 502);
  assert.equal(response.headers.get("content-language"), "pl");
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(await response.text(), i18n.catalogs.pl.secure_tunnel_failed);
  assert.doesNotMatch(readFileSync("web/app/sw.js", "utf8"), /caches\.open|cache\.put/);
});


test("app presentation handles auth, camera, device and pairing states without changing payloads", async () => {
  const runtime = load(null, ["pl-PL"]);
  const elements = new Map<string, any>();
  const make = () => ({ dataset: {}, classList: { toggle() {}, remove() {}, add() {} }, setAttribute() {}, textContent: "" });
  runtime.context.document.getElementById = (id: string) => { if (!elements.has(id)) elements.set(id, make()); return elements.get(id); };
  runtime.context.document.body = { dataset: {} };
  runtime.context.location = { href: "https://relay.test/app/", origin: "https://relay.test" };
  runtime.context.URL = URL;
  runtime.context.URLSearchParams = URLSearchParams;
  runtime.context.Intl = Intl;
  runtime.context.window = runtime.context;
  runtime.context.DshCrypto = { fromBase64Url: (key: string) => { if (key !== "test-key") throw new Error("bad key"); } };
  let request: any;
  runtime.context.fetch = async (path: string, options: any) => { request = { path, options }; return { ok: false, json: async () => ({ error: "invalid_credentials" }) }; };
  const app = readFileSync("web/app/app.js", "utf8").split('elements["auth-form"].addEventListener')[0];
  vm.createContext(runtime.context);
  vm.runInContext(app, runtime.context);
  const evaluate = (code: string) => vm.runInContext(code, runtime.context);
  assert.equal(evaluate('deviceStatus({ online: false }).label'), runtime.i18n.catalogs.pl.offlineStatus);
  assert.equal(evaluate('deviceStatus({ online: true, dshStatus: "online" }).label'), runtime.i18n.catalogs.pl.online);
  evaluate('setAuthMode("register"); setCameraStatus("cameraTimeout", true)');
  assert.equal(elements.get("auth-submit").textContent, runtime.i18n.catalogs.pl.createAccount);
  assert.equal(elements.get("camera-status").textContent, runtime.i18n.catalogs.pl.cameraTimeout);
  assert.equal(evaluate('parsePairInput("123456")'), null);
  assert.equal(evaluate('parsePairInput("https://other.test/app/#/pair?code=123456&key=test-key")'), null);
  assert.equal(evaluate('parsePairInput("https://relay.test/app/#/pair?code=123456&key=test-key").kind'), "computer");
  await assert.rejects(evaluate('api("/web-auth/login", { method: "POST", body: JSON.stringify({email:"中文@example.test", password:"unchanged"}) })'), (error: any) => error.code === "invalid_credentials" && error.message === "invalid_credentials");
  assert.equal(request.options.credentials, "same-origin");
  assert.deepEqual(JSON.parse(request.options.body), { email: "中文@example.test", password: "unchanged" });
  assert.equal(Object.hasOwn(JSON.parse(request.options.body), "locale"), false);
});

test("administration localizes state and metrics but never names or platform values", () => {
  const runtime = load(null, ["pl-PL"]);
  const nodes = new Map<string, any>();
  const make = () => ({ dataset: {}, children: [] as any[], classList: { toggle() {} }, textContent: "", append(...values: any[]) { this.children.push(...values); }, replaceChildren() { this.children = []; } });
  runtime.context.document.getElementById = (id: string) => { if (!nodes.has(id)) nodes.set(id, make()); return nodes.get(id); };
  runtime.context.document.createElement = make;
  runtime.context.Intl = Intl;
  vm.createContext(runtime.context);
  vm.runInContext(readFileSync("web/admin/admin.js", "utf8").split('byId("login-form").addEventListener')[0], runtime.context);
  vm.runInContext('renderSessions([{email:"中文@example.test", deviceName:"我的电脑", platform:"自定义平台", startedAt:0, lastSeenAt:0, status:"active"}])', runtime.context);
  const cells = nodes.get("session-rows").children[0].children;
  assert.equal(cells[0].textContent, "中文@example.test");
  assert.equal(cells[1].textContent, "我的电脑");
  assert.equal(cells[2].textContent, "自定义平台");
  assert.equal(cells[5].textContent, runtime.i18n.catalogs.pl.active);
});


test("native language selector change updates current interface without navigation", () => {
  const runtime = load();
  assert.equal(runtime.selects[0].value, "en");
  runtime.selects[0].value = "pl";
  runtime.selectListeners.get("change")!();
  assert.equal(runtime.i18n.locale, "pl");
  assert.equal(runtime.documentElement.lang, "pl");
  assert.equal(runtime.storage.get("dsh-relay-language"), "pl");
});

test("worker presentation locale is metadata only and tunnel envelope remains v1", async () => {
  const listeners = new Map<string, Function>();
  const context: any = {
    DshI18n: load().i18n, importScripts: () => {},
    indexedDB: { open: () => ({}) }, TextEncoder, TextDecoder,
    crypto: { randomUUID: () => "request-id" },
    self: { addEventListener: (name: string, callback: Function) => listeners.set(name, callback) },
  };
  vm.createContext(context);
  vm.runInContext(readFileSync("web/app/sw.js", "utf8"), context);
  vm.runInContext('tunnels.set("dev_test", {deviceId:"dev_test", locale:"en"}); readSession = async () => ({deviceId:"dev_test", ticket:"unchanged"}); writeSession = async (session) => { globalThis.savedSession = session; };', context);
  let work: Promise<any> | undefined;
  listeners.get("message")!({ data: { type: "set-presentation-locale", locale: "pl" }, ports: [], waitUntil: (promise: Promise<any>) => { work = promise; } });
  await work;
  assert.equal(context.savedSession.locale, "pl");
  assert.equal(context.savedSession.ticket, "unchanged");
  const envelope = vm.runInContext('envelope("http_req", {method:"GET", path:"/unchanged"}, "channel")', context);
  assert.equal(envelope.v, 1);
  assert.deepEqual(Object.keys(envelope).sort(), ["channel", "id", "payload", "ts", "type", "v"]);
  assert.equal(envelope.payload.path, "/unchanged");
  assert.equal(envelope.locale, undefined);
});
