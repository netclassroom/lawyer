(function () {
  "use strict";

  if (window.__sdkgonLoaded) return;
  window.__sdkgonLoaded = true;

  const CLOUD_SAVE_KEY = "sdkgon_unity_idbfs_v3";
  const CLOUD_APPLIED_KEY = "sdkgon_cloud_applied_at_v3";
  const UNITY_DATABASE = "/idbfs";
  const UNITY_DATABASE_VERSION = 21;
  const UNITY_STORE = "FILE_DATA";
  const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

  const state = {
    ysdk: null,
    player: null,
    storage: null,
    initPromise: null,
    initialized: false,
    gameReadySent: false,
    gameLoadedSent: false,
    language: "en",
    gameplayRequested: false,
    gameplayActive: false,
    userActivated: false,
    localMode: false,
    cloudSnapshot: null,
    saveTimer: 0,
    lastSaveSignature: "",
    audioContexts: new Set(),
    mediaObserver: null,
    mediaGuardTimer: 0,
    pokiBridgeName: ""
  };

  const isLocal = () => location.protocol === "file:" || LOCAL_HOSTS.has(location.hostname);

  function isDraftUrl() {
    try {
      const sources = [location.href, document.referrer];
      if (location.ancestorOrigins) sources.push(...Array.from(location.ancestorOrigins));
      return sources.some(value => String(value || "").toLowerCase().includes("draft"));
    } catch (_) {
      return false;
    }
  }

  function warn(label, error) {
    console.warn(`[sdkgon] ${label}`, error || "");
  }

  function getLanguage() {
    return state.language || "en";
  }

  function installAudioContextTracking() {
    for (const key of ["AudioContext", "webkitAudioContext"]) {
      const NativeContext = window[key];
      if (typeof NativeContext !== "function" || NativeContext.__sdkgonWrapped) continue;

      function TrackedAudioContext(...args) {
        const context = new NativeContext(...args);
        state.audioContexts.add(context);

        const nativeResume = context.resume.bind(context);
        context.resume = (...resumeArgs) => {
          if (!state.userActivated || document.visibilityState === "hidden") return Promise.resolve();
          return nativeResume(...resumeArgs);
        };

        const keepSuspendedUntilStart = () => {
          if (!state.userActivated && context.state === "running") {
            context.suspend().catch(() => {});
          }
        };
        context.addEventListener("statechange", keepSuspendedUntilStart);
        Promise.resolve().then(keepSuspendedUntilStart);
        return context;
      }

      TrackedAudioContext.prototype = NativeContext.prototype;
      Object.setPrototypeOf(TrackedAudioContext, NativeContext);
      TrackedAudioContext.__sdkgonWrapped = true;
      window[key] = TrackedAudioContext;
    }
  }

  function suppressSystemMediaPlayer() {
    const clearMediaSession = () => {
      try {
        if (navigator.mediaSession) {
          navigator.mediaSession.metadata = null;
          navigator.mediaSession.playbackState = "none";
          for (const action of ["play", "pause", "stop", "seekbackward", "seekforward", "seekto", "previoustrack", "nexttrack"]) {
            try { navigator.mediaSession.setActionHandler(action, null); } catch (_) {}
          }
        }
      } catch (_) {}
    };

    clearMediaSession();
    if (!state.mediaGuardTimer) state.mediaGuardTimer = window.setInterval(clearMediaSession, 2000);

    const prepareMedia = element => {
      if (!(element instanceof HTMLMediaElement)) return;
      element.controls = false;
      element.disableRemotePlayback = true;
      element.setAttribute("playsinline", "");
      element.setAttribute("webkit-playsinline", "");
    };

    document.querySelectorAll("audio,video").forEach(prepareMedia);
    if (!state.mediaObserver) {
      state.mediaObserver = new MutationObserver(records => {
        for (const record of records) {
          for (const node of record.addedNodes) {
            if (node instanceof HTMLMediaElement) prepareMedia(node);
            if (node instanceof Element) node.querySelectorAll("audio,video").forEach(prepareMedia);
          }
        }
      });
      state.mediaObserver.observe(document.documentElement, { childList: true, subtree: true });
    }
  }

  async function installSafeStorage() {
    if (!state.ysdk || typeof state.ysdk.getStorage !== "function") return;
    try {
      state.storage = await state.ysdk.getStorage();
      try {
        Object.defineProperty(window, "localStorage", {
          configurable: true,
          get: () => state.storage
        });
      } catch (error) {
        warn("Safe storage could not replace localStorage", error);
      }
    } catch (error) {
      warn("Safe storage is unavailable; browser storage remains active", error);
    }
  }

  function requestToPromise(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("IndexedDB request failed"));
    });
  }

  function transactionDone(transaction) {
    return new Promise((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error || new Error("IndexedDB transaction failed"));
      transaction.onabort = () => reject(transaction.error || new Error("IndexedDB transaction aborted"));
    });
  }

  function bytesToBase64(value) {
    const bytes = value instanceof Uint8Array
      ? value
      : value instanceof ArrayBuffer
        ? new Uint8Array(value)
        : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += 0x8000) {
      binary += String.fromCharCode.apply(null, bytes.subarray(offset, offset + 0x8000));
    }
    return btoa(binary);
  }

  function base64ToBytes(value) {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  }

  function serializeValue(value) {
    if (value instanceof Date) return { $date: value.getTime() };
    if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return { $bytes: bytesToBase64(value) };
    if (Array.isArray(value)) return value.map(serializeValue);
    if (value && typeof value === "object") {
      const result = {};
      for (const [key, child] of Object.entries(value)) result[key] = serializeValue(child);
      return result;
    }
    return value;
  }

  function deserializeValue(value) {
    if (Array.isArray(value)) return value.map(deserializeValue);
    if (value && typeof value === "object") {
      if (typeof value.$bytes === "string") return base64ToBytes(value.$bytes);
      if (typeof value.$date === "number") return new Date(value.$date);
      const result = {};
      for (const [key, child] of Object.entries(value)) result[key] = deserializeValue(child);
      return result;
    }
    return value;
  }

  function openExistingDatabase(name) {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(name);
      let created = false;
      request.onupgradeneeded = () => { created = true; };
      request.onsuccess = () => {
        const database = request.result;
        if (!created) {
          resolve(database);
          return;
        }
        database.close();
        const deletion = indexedDB.deleteDatabase(name);
        deletion.onsuccess = () => resolve(null);
        deletion.onerror = () => reject(deletion.error || new Error(`Cannot remove empty ${name}`));
      };
      request.onerror = () => reject(request.error || new Error(`Cannot open ${name}`));
    });
  }

  async function exportUnityDatabase() {
    const database = await openExistingDatabase(UNITY_DATABASE);
    if (!database) return null;

    try {
      const stores = {};
      let localUpdatedAt = 0;
      for (const storeName of Array.from(database.objectStoreNames)) {
        const transaction = database.transaction(storeName, "readonly");
        const store = transaction.objectStore(storeName);
        const keys = await requestToPromise(store.getAllKeys());
        const values = await requestToPromise(store.getAll());
        const indexes = Array.from(store.indexNames).map(indexName => {
          const index = store.index(indexName);
          return { name: index.name, keyPath: index.keyPath, unique: index.unique, multiEntry: index.multiEntry };
        });

        for (const value of values) {
          const timestamp = value && value.timestamp instanceof Date ? value.timestamp.getTime() : 0;
          localUpdatedAt = Math.max(localUpdatedAt, timestamp);
        }

        stores[storeName] = {
          keyPath: store.keyPath,
          autoIncrement: store.autoIncrement,
          indexes,
          records: keys.map((key, index) => ({
            key: serializeValue(key),
            value: serializeValue(values[index])
          }))
        };
      }

      return { name: UNITY_DATABASE, version: database.version, localUpdatedAt, stores };
    } finally {
      database.close();
    }
  }

  function openDatabaseForImport(snapshot) {
    return new Promise((resolve, reject) => {
      const version = Math.max(Number(snapshot.version) || 1, UNITY_DATABASE_VERSION);
      const request = indexedDB.open(snapshot.name || UNITY_DATABASE, version);
      request.onupgradeneeded = event => {
        const database = request.result;
        const transaction = event.target.transaction;
        for (const [storeName, storeSnapshot] of Object.entries(snapshot.stores || {})) {
          let store;
          if (database.objectStoreNames.contains(storeName)) {
            store = transaction.objectStore(storeName);
          } else {
            const options = {};
            if (storeSnapshot.keyPath !== null && storeSnapshot.keyPath !== undefined) options.keyPath = storeSnapshot.keyPath;
            if (storeSnapshot.autoIncrement) options.autoIncrement = true;
            store = database.createObjectStore(storeName, options);
          }
          for (const index of storeSnapshot.indexes || []) {
            if (!store.indexNames.contains(index.name)) {
              store.createIndex(index.name, index.keyPath, { unique: Boolean(index.unique), multiEntry: Boolean(index.multiEntry) });
            }
          }
        }

        if (!database.objectStoreNames.contains(UNITY_STORE)) {
          const store = database.createObjectStore(UNITY_STORE);
          store.createIndex("timestamp", "timestamp", { unique: false });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("Cannot prepare Unity save database"));
    });
  }

  async function importUnityDatabase(snapshot) {
    const database = await openDatabaseForImport(snapshot);
    try {
      for (const [storeName, storeSnapshot] of Object.entries(snapshot.stores || {})) {
        if (!database.objectStoreNames.contains(storeName)) continue;
        const transaction = database.transaction(storeName, "readwrite");
        const store = transaction.objectStore(storeName);
        store.clear();
        for (const record of storeSnapshot.records || []) {
          const key = deserializeValue(record.key);
          const value = deserializeValue(record.value);
          if (store.keyPath === null) store.put(value, key);
          else store.put(value);
        }
        await transactionDone(transaction);
      }
    } finally {
      database.close();
    }
  }

  async function loadCloudSnapshot() {
    if (!state.player || typeof state.player.getData !== "function") return;
    try {
      const data = await state.player.getData([CLOUD_SAVE_KEY]);
      state.cloudSnapshot = data && data[CLOUD_SAVE_KEY] ? data[CLOUD_SAVE_KEY] : null;
    } catch (error) {
      warn("Cloud save lookup failed", error);
    }
  }

  async function restoreCloudSaveIfNeeded() {
    const snapshot = state.cloudSnapshot;
    if (!snapshot || snapshot.version !== 3 || !snapshot.database) return false;

    try {
      const localDatabase = await exportUnityDatabase();
      const localUpdatedAt = Number(localDatabase && localDatabase.localUpdatedAt) || 0;
      const cloudUpdatedAt = Number(snapshot.database.localUpdatedAt) || Number(snapshot.savedAt) || 0;
      if (localUpdatedAt >= cloudUpdatedAt && localUpdatedAt > 0) return false;

      await importUnityDatabase(snapshot.database);
      const marker = String(snapshot.savedAt || Date.now());
      try { (state.storage || localStorage).setItem(CLOUD_APPLIED_KEY, marker); } catch (_) {}
      return true;
    } catch (error) {
      warn("Cloud save restore failed", error);
      return false;
    }
  }

  async function saveToCloud(force) {
    if (!state.player || typeof state.player.setData !== "function") return false;
    try {
      const database = await exportUnityDatabase();
      if (!database || !Object.keys(database.stores || {}).length) return false;

      const signature = JSON.stringify(database.stores);
      if (!force && signature === state.lastSaveSignature) return true;

      const snapshot = { version: 3, savedAt: Date.now(), database };
      const payloadSize = JSON.stringify(snapshot).length;
      if (payloadSize > 190000) {
        warn(`Cloud save is too large (${payloadSize} characters)`);
        return false;
      }

      await state.player.setData({ [CLOUD_SAVE_KEY]: snapshot }, Boolean(force));
      state.lastSaveSignature = signature;
      state.cloudSnapshot = snapshot;
      try { (state.storage || localStorage).setItem(CLOUD_APPLIED_KEY, String(snapshot.savedAt)); } catch (_) {}
      return true;
    } catch (error) {
      warn("Cloud save backup failed", error);
      return false;
    }
  }

  function beginSaveProtection() {
    if (state.saveTimer) return;
    window.setTimeout(() => saveToCloud(false), 6000);
    state.saveTimer = window.setInterval(() => saveToCloud(false), 15000);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") saveToCloud(true);
    });
    window.addEventListener("pagehide", () => saveToCloud(true));
  }

  function installLifecycleHandlers() {
    if (state.ysdk && typeof state.ysdk.on === "function") {
      state.ysdk.on("game_api_pause", () => {
        gameplayStop(false);
        pauseAudio();
      });
      state.ysdk.on("game_api_resume", () => {
        if (!state.userActivated) return;
        gameplayStart();
        resumeAudio();
      });
    }

    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") {
        setGameplayActive(false);
        pauseAudio();
      } else if (state.userActivated && state.gameplayRequested) {
        setGameplayActive(true);
        resumeAudio();
      }
    });
    window.addEventListener("blur", () => pauseAudio());
  }

  function notifyPokiBridgeReady() {
    if (!state.pokiBridgeName || !window.unityGame || typeof window.unityGame.SendMessage !== "function") return;
    try { window.unityGame.SendMessage(state.pokiBridgeName, "ready"); } catch (error) { warn("Unity bridge ready message failed", error); }
  }

  async function init() {
    if (state.initPromise) return state.initPromise;
    state.initPromise = (async () => {
      if (typeof window.YaGames === "undefined") {
        if (!isLocal()) throw new Error("Yandex Games SDK /sdk.js is unavailable");
        state.localMode = true;
        state.language = (navigator.language || "en").slice(0, 2).toLowerCase();
        document.documentElement.lang = state.language;
        state.initialized = true;
        console.info("[sdkgon] Local SDK fallback is active");
        notifyPokiBridgeReady();
        return null;
      }

      state.ysdk = await window.YaGames.init();
      state.language = String(state.ysdk && state.ysdk.environment && state.ysdk.environment.i18n && state.ysdk.environment.i18n.lang || "en").toLowerCase();
      document.documentElement.lang = state.language;
      await installSafeStorage();

      try {
        state.player = await state.ysdk.getPlayer({ scopes: false });
      } catch (error) {
        warn("Player API is unavailable; local Unity saves remain active", error);
      }

      await loadCloudSnapshot();
      await restoreCloudSaveIfNeeded();
      installLifecycleHandlers();
      state.initialized = true;
      notifyPokiBridgeReady();
      return state.ysdk;
    })();
    return state.initPromise;
  }

  async function gameReady() {
    if (state.gameReadySent) return;
    await init();
    if (state.ysdk && state.ysdk.features && state.ysdk.features.LoadingAPI && state.ysdk.features.LoadingAPI.ready) {
      await state.ysdk.features.LoadingAPI.ready();
    }
    state.gameReadySent = true;
  }

  function notifyGameLoaded() {
    if (state.gameLoadedSent) return;
    state.gameLoadedSent = true;
    window.dispatchEvent(new CustomEvent("sdkgon:game-loaded"));
  }

  function setGameplayActive(active) {
    if (state.gameplayActive === active) return;
    state.gameplayActive = active;
    try {
      const api = state.ysdk && state.ysdk.features && state.ysdk.features.GameplayAPI;
      if (active && api && api.start) api.start();
      if (!active && api && api.stop) api.stop();
    } catch (error) {
      warn(`GameplayAPI.${active ? "start" : "stop"} failed`, error);
    }
  }

  function gameplayStart() {
    state.gameplayRequested = true;
    beginSaveProtection();
    if (state.userActivated && document.visibilityState !== "hidden") setGameplayActive(true);
  }

  function gameplayStop(clearRequest = true) {
    if (clearRequest) state.gameplayRequested = false;
    setGameplayActive(false);
  }

  async function pauseAudio() {
    for (const context of state.audioContexts) {
      try { if (context.state === "running") await context.suspend(); } catch (_) {}
    }
    suppressSystemMediaPlayer();
  }

  async function resumeAudio() {
    if (!state.userActivated || document.visibilityState === "hidden") return;
    for (const context of state.audioContexts) {
      try { if (context.state !== "running") await context.resume(); } catch (error) { warn("Web Audio resume failed", error); }
    }
  }

  function markUserActivated() {
    state.userActivated = true;
    resumeAudio();
    if (state.gameplayRequested) setGameplayActive(true);
  }

  function commercialBreak() {
    return new Promise(resolve => {
      if (isDraftUrl() || !state.userActivated || !state.ysdk || !state.ysdk.adv || !state.ysdk.adv.showFullscreenAdv) {
        resolve(false);
        return;
      }

      const resumeGameplay = state.gameplayRequested;
      setGameplayActive(false);
      pauseAudio();
      let settled = false;
      const finish = shown => {
        if (settled) return;
        settled = true;
        if (resumeGameplay && state.userActivated) setGameplayActive(true);
        resumeAudio();
        resolve(Boolean(shown));
      };

      try {
        state.ysdk.adv.showFullscreenAdv({
          callbacks: {
            onOpen: () => { setGameplayActive(false); pauseAudio(); },
            onClose: wasShown => finish(wasShown),
            onError: error => { warn("Fullscreen ad failed", error); finish(false); }
          }
        });
      } catch (error) {
        warn("Fullscreen ad call failed", error);
        finish(false);
      }
    });
  }

  function rewardedBreak() {
    return new Promise(resolve => {
      if (!state.ysdk || !state.ysdk.adv || !state.ysdk.adv.showRewardedVideo) {
        resolve(false);
        return;
      }

      const resumeGameplay = state.gameplayRequested;
      setGameplayActive(false);
      pauseAudio();
      let rewarded = false;
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        if (resumeGameplay && state.userActivated) setGameplayActive(true);
        resumeAudio();
        resolve(rewarded);
      };

      try {
        state.ysdk.adv.showRewardedVideo({
          callbacks: {
            onOpen: () => { setGameplayActive(false); pauseAudio(); },
            onRewarded: () => { rewarded = true; },
            onClose: finish,
            onError: error => { warn("Rewarded ad failed", error); finish(); }
          }
        });
      } catch (error) {
        warn("Rewarded ad call failed", error);
        finish();
      }
    });
  }

  function shareableURL(params) {
    const url = new URL(location.href);
    url.search = "";
    if (params && typeof params === "object") {
      for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
    }
    return Promise.resolve(url.toString());
  }

  function sendBridgeMessage(method, value) {
    if (!state.pokiBridgeName || !window.unityGame || typeof window.unityGame.SendMessage !== "function") return;
    try {
      if (value === undefined) window.unityGame.SendMessage(state.pokiBridgeName, method);
      else window.unityGame.SendMessage(state.pokiBridgeName, method, String(value));
    } catch (error) {
      warn(`Unity bridge message ${method} failed`, error);
    }
  }

  installAudioContextTracking();
  suppressSystemMediaPlayer();

  const PokiSDK = {
    init,
    setDebug() {},
    gameLoadingStart() {},
    gameLoadingProgress() {},
    gameLoadingFinished: notifyGameLoaded,
    gameInteractive: gameplayStart,
    gameplayStart,
    gameplayStop,
    commercialBreak,
    rewardedBreak,
    getLanguage,
    getURLParam: name => new URL(location.href).searchParams.get(name) || "",
    isAdBlocked: () => false,
    customEvent() {},
    happyTime() {},
    roundStart() {},
    roundEnd() {},
    setPlayerAge() {},
    togglePlayerAdvertisingConsent() {},
    displayAd() {},
    destroyAd() {},
    logError: error => console.error(error),
    measure() {},
    shareableURL,
    getUser: async () => state.player || {},
    getToken: async () => "",
    login: async () => state.player || {}
  };

  window.initPokiBridge = name => {
    state.pokiBridgeName = String(name || "");
    if (state.initialized) notifyPokiBridgeReady();
  };
  window.commercialBreak = () => commercialBreak().then(() => sendBridgeMessage("commercialBreakCompleted"));
  window.rewardedBreak = () => rewardedBreak().then(rewarded => sendBridgeMessage("rewardedBreakCompleted", rewarded));
  window.shareableURL = params => shareableURL(params)
    .then(url => sendBridgeMessage("shareableURLResolved", url))
    .catch(() => sendBridgeMessage("shareableURLRejected"));
  window.getUser = () => PokiSDK.getUser()
    .then(user => sendBridgeMessage("getUserResolved", JSON.stringify(user || {})))
    .catch(() => sendBridgeMessage("getUserRejected"));
  window.getToken = () => PokiSDK.getToken()
    .then(token => sendBridgeMessage("getTokenResolved", token || ""))
    .catch(() => sendBridgeMessage("getTokenRejected"));
  window.login = () => PokiSDK.login()
    .then(() => sendBridgeMessage("loginResolved"))
    .catch(() => sendBridgeMessage("loginRejected"));

  window.SdkGon = {
    init,
    gameReady,
    notifyGameLoaded,
    getLanguage,
    gameplayStart,
    gameplayStop,
    pauseAudio,
    resumeAudio,
    markUserActivated,
    beginSaveProtection,
    restoreCloudSaveIfNeeded,
    saveNow: () => saveToCloud(true),
    isDraft: isDraftUrl,
    get ysdk() { return state.ysdk; },
    get player() { return state.player; },
    get localMode() { return state.localMode; }
  };
  window.PokiSDK = PokiSDK;

  // The legacy Unity integration tries to clean up Poki globals after boot.
  // Keep the compatibility bridge available for later ad and lifecycle calls.
  const protectedGlobals = [
    "SdkGon",
    "PokiSDK",
    "initPokiBridge",
    "commercialBreak",
    "rewardedBreak",
    "shareableURL",
    "getUser",
    "getToken",
    "login",
    "__sdkgonLoaded"
  ];
  for (const name of protectedGlobals) {
    Object.defineProperty(window, name, {
      value: window[name],
      configurable: false,
      enumerable: false,
      writable: false
    });
  }
  Object.defineProperty(window, "unityGame", {
    value: null,
    configurable: false,
    enumerable: false,
    writable: true
  });
})();
