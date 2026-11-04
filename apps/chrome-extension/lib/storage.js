/**
 * Tyno Connect — wrapper chrome.storage.sync
 * Ne stocke jamais de secrets en clair dans le DOM ni les logs.
 */

const TynoStorage = {
  async get(key) {
    return new Promise((resolve) => {
      chrome.storage.sync.get([key], (result) => resolve(result[key]));
    });
  },

  async getAll() {
    return new Promise((resolve) => {
      chrome.storage.sync.get(["tynoApiUrl", "tynoApiToken", "lastSync", "connected"], resolve);
    });
  },

  async set(data) {
    return new Promise((resolve) => {
      chrome.storage.sync.set(data, resolve);
    });
  },

  async getApiConfig() {
    const { tynoApiUrl, tynoApiToken } = await this.getAll();
    return { url: tynoApiUrl || "", token: tynoApiToken || "" };
  },

  async setLastSync() {
    await this.set({ lastSync: new Date().toISOString() });
  },

  async setConnected(value) {
    await this.set({ connected: !!value });
  },

  async clear() {
    return new Promise((resolve) => {
      chrome.storage.sync.remove(["tynoApiToken", "connected", "lastSync"], resolve);
    });
  },
};
