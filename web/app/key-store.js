(function (scope) {
  "use strict";

  const database = new Promise((resolve, reject) => {
    const request = indexedDB.open("dsh-remote-web", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("device-keys");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

  async function transact(mode, action) {
    const db = await database;
    return new Promise((resolve, reject) => {
      const transaction = db.transaction("device-keys", mode);
      const request = action(transaction.objectStore("device-keys"));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  scope.DshKeyStore = {
    get(deviceId) {
      return transact("readonly", (store) => store.get(deviceId));
    },
    set(deviceId, key) {
      return transact("readwrite", (store) => store.put(key, deviceId));
    },
    remove(deviceId) {
      return transact("readwrite", (store) => store.delete(deviceId));
    },
  };
})(window);
