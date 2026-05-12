// Preload script — renderer 와 main process 사이의 안전한 IPC bridge.
// contextIsolation:true 환경에서 renderer 는 window.docConverter 만 접근 가능.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('docConverter', {
  // Settings — API 키 관리 (keytar 경유)
  getKeyStatus: () => ipcRenderer.invoke('settings:get-key-status'),
  setKey: (name, value) => ipcRenderer.invoke('settings:set-key', { name, value }),
  deleteKey: (name) => ipcRenderer.invoke('settings:delete-key', { name }),

  // 폴더 (Finder)
  openOutputFolder: () => ipcRenderer.invoke('folders:open-output'),
  openTemplatesFolder: () => ipcRenderer.invoke('folders:open-templates'),
  openLogsFolder: () => ipcRenderer.invoke('folders:open-logs'),
  getFolderPaths: () => ipcRenderer.invoke('folders:get-paths'),

  // 다운로드 완료 알림 (toast 용) + Finder 에서 보기
  onDownloadComplete: (callback) => {
    const handler = (_evt, payload) => callback(payload);
    ipcRenderer.on('download:completed', handler);
    return () => ipcRenderer.removeListener('download:completed', handler);
  },
  revealInFinder: (filePath) => ipcRenderer.invoke('downloads:reveal', filePath),

  // 환경 식별 (renderer 가 Electron 모드인지 확인용)
  isElectron: true,
});
