const { contextBridge, ipcRenderer } = require('electron');

// The renderer never touches Node or ipcRenderer directly. It only sees
// this narrow, explicit API surface -- the same containment pattern
// Postman uses in its preload bridge.
//
// This file is intentionally .cjs (CommonJS): Electron preload scripts must
// be CommonJS, and the package is otherwise "type": "module".
contextBridge.exposeInMainWorld('api', {
  sendRequest: (request, requestId) => ipcRenderer.invoke('http:send', { request, requestId }),
  abortRequest: (requestId) => ipcRenderer.invoke('http:abort', requestId),
  wsConnect: (payload) => ipcRenderer.invoke('ws:connect', payload),
  wsSend: (payload) => ipcRenderer.invoke('ws:send', payload),
  wsClose: (payload) => ipcRenderer.invoke('ws:close', payload),
  onWsEvent: (cb) => {
    const handler = (_event, payload) => cb(payload);
    ipcRenderer.on('ws:event', handler);
    return () => ipcRenderer.removeListener('ws:event', handler);
  },
  runScript: (payload) => ipcRenderer.invoke('script:run', payload),
  pickFile: () => ipcRenderer.invoke('file:pick'),
  saveResponse: (payload) => ipcRenderer.invoke('response:save', payload),
  getOAuth2Token: (cfg) => ipcRenderer.invoke('oauth2:token', cfg),
  authorizeOAuth2: (cfg) => ipcRenderer.invoke('oauth2:authorize', cfg),
  getOAuth2Status: (cfg) => ipcRenderer.invoke('oauth2:status', cfg),
  getCookies: () => ipcRenderer.invoke('cookies:get'),
  setCookie: (cookie) => ipcRenderer.invoke('cookies:set', cookie),
  deleteCookie: (identity) => ipcRenderer.invoke('cookies:delete', identity),
  clearCookies: () => ipcRenderer.invoke('cookies:clear'),
  encryptSecret: (value) => ipcRenderer.invoke('secrets:encrypt', value),
  decryptSecret: (encoded) => ipcRenderer.invoke('secrets:decrypt', encoded),
  decryptSecrets: (encodedList) => ipcRenderer.invoke('secrets:decryptMany', encodedList),
  onCloseRequested: (cb) => {
    const handler = () => cb();
    ipcRenderer.on('app:close-requested', handler);
    return () => ipcRenderer.removeListener('app:close-requested', handler);
  },
  confirmClose: () => ipcRenderer.invoke('app:close-confirmed'),
  getNetworkSettings: () => ipcRenderer.invoke('network:get'),
  setNetworkSettings: (settings) => ipcRenderer.invoke('network:set', settings),
  loadData: () => ipcRenderer.invoke('store:get'),
  saveData: (data) => ipcRenderer.invoke('store:set', data),
});
