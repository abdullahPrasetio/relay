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
  runScript: (payload) => ipcRenderer.invoke('script:run', payload),
  pickFile: () => ipcRenderer.invoke('file:pick'),
  saveResponse: (payload) => ipcRenderer.invoke('response:save', payload),
  getOAuth2Token: (cfg) => ipcRenderer.invoke('oauth2:token', cfg),
  authorizeOAuth2: (cfg) => ipcRenderer.invoke('oauth2:authorize', cfg),
  getOAuth2Status: (cfg) => ipcRenderer.invoke('oauth2:status', cfg),
  getCookies: () => ipcRenderer.invoke('cookies:get'),
  clearCookies: () => ipcRenderer.invoke('cookies:clear'),
  getNetworkSettings: () => ipcRenderer.invoke('network:get'),
  setNetworkSettings: (settings) => ipcRenderer.invoke('network:set', settings),
  loadData: () => ipcRenderer.invoke('store:get'),
  saveData: (data) => ipcRenderer.invoke('store:set', data),
});
