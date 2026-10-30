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
  mqttConnect: (payload) => ipcRenderer.invoke('mqtt:connect', payload),
  mqttPublish: (payload) => ipcRenderer.invoke('mqtt:publish', payload),
  mqttSubscribe: (payload) => ipcRenderer.invoke('mqtt:subscribe', payload),
  mqttUnsubscribe: (payload) => ipcRenderer.invoke('mqtt:unsubscribe', payload),
  mqttClose: (payload) => ipcRenderer.invoke('mqtt:close', payload),
  onMqttEvent: (cb) => {
    const handler = (_event, payload) => cb(payload);
    ipcRenderer.on('mqtt:event', handler);
    return () => ipcRenderer.removeListener('mqtt:event', handler);
  },
  socketIoConnect: (payload) => ipcRenderer.invoke('socketio:connect', payload),
  socketIoEmit: (payload) => ipcRenderer.invoke('socketio:emit', payload),
  socketIoClose: (payload) => ipcRenderer.invoke('socketio:close', payload),
  onSocketIoEvent: (cb) => {
    const handler = (_event, payload) => cb(payload);
    ipcRenderer.on('socketio:event', handler);
    return () => ipcRenderer.removeListener('socketio:event', handler);
  },
  grpcServices: (payload) => ipcRenderer.invoke('grpc:services', payload),
  grpcInvoke: (payload) => ipcRenderer.invoke('grpc:invoke', payload),
  grpcStreamStart: (payload) => ipcRenderer.invoke('grpc:stream', payload),
  grpcStreamCancel: (id) => ipcRenderer.invoke('grpc:cancel', id),
  onGrpcEvent: (cb) => {
    const handler = (_event, payload) => cb(payload);
    ipcRenderer.on('grpc:event', handler);
    return () => ipcRenderer.removeListener('grpc:event', handler);
  },
  runScript: (payload) => ipcRenderer.invoke('script:run', payload),
  pickFile: () => ipcRenderer.invoke('file:pick'),
  exportWorkspace: (files, suggestedName) =>
    ipcRenderer.invoke('workspace:export', { files, suggestedName }),
  importWorkspaceFiles: () => ipcRenderer.invoke('workspace:import'),
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
  mockStart: (payload) => ipcRenderer.invoke('mock:start', payload),
  mockStop: () => ipcRenderer.invoke('mock:stop'),
  mockStatus: () => ipcRenderer.invoke('mock:status'),
  loadData: () => ipcRenderer.invoke('store:get'),
  saveData: (data) => ipcRenderer.invoke('store:set', data),
  // Relay Cloud (relay-api). Credentials stay in the main process; these
  // calls only ever return user/workspace data.
  cloud: {
    status: () => ipcRenderer.invoke('cloud:status'),
    login: (payload) => ipcRenderer.invoke('cloud:login', payload),
    register: (payload) => ipcRenderer.invoke('cloud:register', payload),
    logout: () => ipcRenderer.invoke('cloud:logout'),
    workspaces: () => ipcRenderer.invoke('cloud:workspaces'),
    createWorkspace: (payload) => ipcRenderer.invoke('cloud:create-workspace', payload),
    renameWorkspace: (payload) => ipcRenderer.invoke('cloud:rename-workspace', payload),
    deleteWorkspace: (payload) => ipcRenderer.invoke('cloud:delete-workspace', payload),
    push: (payload) => ipcRenderer.invoke('cloud:push', payload),
    pull: (payload) => ipcRenderer.invoke('cloud:pull', payload),
    devices: () => ipcRenderer.invoke('cloud:devices'),
    revokeDevice: (payload) => ipcRenderer.invoke('cloud:revoke-device', payload),
  },
});
