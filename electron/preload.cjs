const { contextBridge, ipcRenderer } = require('electron');

// The renderer never touches Node or ipcRenderer directly. It only sees
// this narrow, explicit API surface -- the same containment pattern
// Postman uses in its preload bridge.
//
// This file is intentionally .cjs (CommonJS): Electron preload scripts must
// be CommonJS, and the package is otherwise "type": "module".
contextBridge.exposeInMainWorld('api', {
  sendRequest: (request) => ipcRenderer.invoke('http:send', request),
  runScript: (payload) => ipcRenderer.invoke('script:run', payload),
  pickFile: () => ipcRenderer.invoke('file:pick'),
  getOAuth2Token: (cfg) => ipcRenderer.invoke('oauth2:token', cfg),
  getCookies: () => ipcRenderer.invoke('cookies:get'),
  clearCookies: () => ipcRenderer.invoke('cookies:clear'),
  loadData: () => ipcRenderer.invoke('store:get'),
  saveData: (data) => ipcRenderer.invoke('store:set', data),
});
