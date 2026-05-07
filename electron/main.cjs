// Electron main process — CJS (CommonJS).
// 이유: 'electron' 모듈은 CJS 라 ESM 컨텍스트에서 require/import 하면 API 객체가 아닌
// binary path string 만 반환됨 (확인됨). main process 만 CJS, 나머지 src 는 ESM.

const { app, BrowserWindow, Menu, shell, ipcMain } = require('electron');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const { spawn } = require('node:child_process');
const { exec } = require('node:child_process');
const { promisify } = require('node:util');
const execAsync = promisify(exec);

const KEYTAR_SERVICE = 'doc-converter';
const MANAGED_KEYS = ['GEMINI_API_KEY', 'CLAUDE_API_KEY'];

/**
 * macOS Keychain wrapper — `security` CLI 직접 호출.
 * keytar native module 대안: arch-mismatch (electron-builder 가 마지막 rebuild를 x64로 남김)
 * 같은 빌드 함정이 없고, ASAR unpack 도 불필요.
 */
const keychain = {
  async setPassword(service, account, password) {
    // password 는 -w 다음 인자로 — spawn 사용해서 shell escape 회피
    return new Promise((resolve, reject) => {
      const proc = spawn('security', [
        'add-generic-password', '-U', '-s', service, '-a', account, '-w', password,
      ]);
      let stderr = '';
      proc.stderr.on('data', (d) => { stderr += d.toString(); });
      proc.on('error', reject);
      proc.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`security exit ${code}: ${stderr.trim()}`));
      });
    });
  },

  async getPassword(service, account) {
    try {
      const { stdout } = await execAsync(
        `security find-generic-password -s ${JSON.stringify(service)} -a ${JSON.stringify(account)} -w`,
      );
      return stdout.trim() || null;
    } catch {
      return null; // 없음
    }
  },

  async deletePassword(service, account) {
    try {
      await execAsync(
        `security delete-generic-password -s ${JSON.stringify(service)} -a ${JSON.stringify(account)}`,
      );
      return true;
    } catch {
      return false;
    }
  },
};

/** 출력 디렉토리 — 사용자 다운로드 자동 저장 위치 */
const OUTPUT_DIR = path.join(app.getPath('documents'), 'Doc Converter Output');

/** 사용자 템플릿 디렉토리 — CLI 와 호환 (template-loader.ts 와 일치) */
const TEMPLATES_DIR = path.join(os.homedir(), '.doc-converter', 'meeting-templates');

function ensureUserDirs() {
  for (const dir of [OUTPUT_DIR, TEMPLATES_DIR]) {
    try {
      fsSync.mkdirSync(dir, { recursive: true });
    } catch (err) {
      console.warn('[electron] 디렉토리 생성 실패:', dir, err && err.message);
    }
  }
}

const PORT_START = 3002;
const PORT_RANGE = 20;

let serverPort = PORT_START;
let mainWindow = null;

/**
 * 사용 가능한 포트 탐색 — 다른 인스턴스가 잡고 있으면 +1.
 */
async function findAvailablePort(start, max) {
  for (let port = start; port < max; port++) {
    const ok = await new Promise((resolve) => {
      const srv = http.createServer();
      srv.once('error', () => resolve(false));
      srv.once('listening', () => srv.close(() => resolve(true)));
      srv.listen(port, '127.0.0.1');
    });
    if (ok) return port;
  }
  throw new Error(`사용 가능한 포트를 찾을 수 없습니다 (${start}~${max})`);
}

/**
 * macOS Keychain (keytar) 에서 저장된 API 키를 process.env 로 주입.
 * Settings UI 에서 저장된 키가 .env.local 보다 우선.
 */
async function loadEnvFromKeychain() {
  for (const key of MANAGED_KEYS) {
    try {
      const value = await keychain.getPassword(KEYTAR_SERVICE, key);
      if (value) {
        process.env[key] = value;
        console.log(`[electron] keychain: ${key} loaded`);
      }
    } catch (err) {
      console.warn(`[electron] keychain read 실패 (${key}):`, err && err.message);
    }
  }
}

/**
 * .env.local 로딩 (fallback). keytar 에 없는 키만 채움.
 * - 개발 모드 (npm run dev:electron): cwd 의 .env.local
 * - 패키징된 .app: app.getPath('userData') 의 .env.local
 */
async function loadEnvFromFile() {
  const candidates = [
    path.join(app.getPath('userData'), '.env.local'),
    path.join(process.cwd(), '.env.local'),
  ];
  for (const p of candidates) {
    try {
      const content = await fs.readFile(p, 'utf-8');
      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eq = trimmed.indexOf('=');
        if (eq <= 0) continue;
        const key = trimmed.slice(0, eq).trim();
        const value = trimmed.slice(eq + 1).trim();
        if (!process.env[key]) process.env[key] = value;
      }
      console.log(`[electron] env loaded: ${p}`);
      return;
    } catch {
      // 다음 후보
    }
  }
  console.warn('[electron] .env.local 없음 — Settings 화면(Phase 3) 또는 환경변수로 API 키 설정 필요');
}

async function startExpressServer() {
  serverPort = await findAvailablePort(PORT_START, PORT_START + PORT_RANGE);
  // src 는 ESM → CJS 안에서 dynamic import
  const { createServer } = await import('../dist/src/ui/server.js');
  const expressApp = createServer();
  await new Promise((resolve, reject) => {
    const httpServer = expressApp.listen(serverPort, '127.0.0.1', () => {
      console.log(`[electron] Express listening on http://localhost:${serverPort}`);
      resolve();
    });
    httpServer.once('error', reject);
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    title: 'Doc Converter',
    backgroundColor: '#0f1117',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.cjs'),
    },
  });

  mainWindow.loadURL(`http://localhost:${serverPort}`);

  // 외부 링크는 시스템 브라우저로
  mainWindow.webContents.setWindowOpenHandler((details) => {
    if (details.url.startsWith('http://localhost:')) return { action: 'allow' };
    void shell.openExternal(details.url);
    return { action: 'deny' };
  });

  // 다운로드 자동 저장 — 사용자 다이얼로그 안 거치고 OUTPUT_DIR 로 직행
  mainWindow.webContents.session.on('will-download', (_event, item) => {
    const filename = item.getFilename();
    const target = path.join(OUTPUT_DIR, filename);
    item.setSavePath(target);
    item.once('done', (_evt, state) => {
      if (state === 'completed') {
        console.log('[electron] saved:', target);
        // renderer 에 toast 알림
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('download:completed', { filename, savedPath: target });
        }
      } else {
        console.warn('[electron] download failed:', state, target);
      }
    });
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac
      ? [
          {
            label: 'Doc Converter',
            submenu: [
              { role: 'about' },
              { type: 'separator' },
              { role: 'hide' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              { role: 'quit' },
            ],
          },
        ]
      : []),
    {
      label: '편집',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: '보기',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: '윈도우',
      submenu: [{ role: 'minimize' }, { role: 'close' }],
    },
    {
      label: '폴더',
      submenu: [
        {
          label: '출력 폴더 열기',
          click: () => { void shell.openPath(OUTPUT_DIR); },
        },
        {
          label: '템플릿 폴더 열기',
          click: () => { void shell.openPath(TEMPLATES_DIR); },
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ─── IPC: Settings / API key 관리 ──────────────────────────
function registerIpc() {
  // 키 설정 여부만 반환 (값 자체는 renderer 에 노출 안 함)
  ipcMain.handle('settings:get-key-status', async () => {
    const result = {};
    for (const key of MANAGED_KEYS) {
      try {
        const v = await keychain.getPassword(KEYTAR_SERVICE, key);
        result[key] = Boolean(v);
      } catch {
        result[key] = false;
      }
    }
    return result;
  });

  ipcMain.handle('settings:set-key', async (_evt, payload) => {
    const { name, value } = payload || {};
    if (!MANAGED_KEYS.includes(name)) {
      return { ok: false, error: `허용되지 않은 키: ${name}` };
    }
    if (typeof value !== 'string' || value.trim().length < 10) {
      return { ok: false, error: 'API 키가 너무 짧습니다.' };
    }
    try {
      await keychain.setPassword(KEYTAR_SERVICE, name, value.trim());
      // 즉시 process.env 갱신 — 다음 API 호출부터 반영
      process.env[name] = value.trim();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err && err.message };
    }
  });

  // 다운로드 완료된 파일을 Finder 에서 표시 (선택 + 폴더 열기)
  ipcMain.handle('downloads:reveal', async (_evt, filePath) => {
    if (typeof filePath !== 'string') return;
    shell.showItemInFolder(filePath);
  });

  // 폴더 열기 (Finder)
  ipcMain.handle('folders:open-output', async () => {
    return shell.openPath(OUTPUT_DIR);
  });
  ipcMain.handle('folders:open-templates', async () => {
    return shell.openPath(TEMPLATES_DIR);
  });
  ipcMain.handle('folders:get-paths', async () => ({
    output: OUTPUT_DIR,
    templates: TEMPLATES_DIR,
  }));

  ipcMain.handle('settings:delete-key', async (_evt, payload) => {
    const { name } = payload || {};
    if (!MANAGED_KEYS.includes(name)) {
      return { ok: false, error: `허용되지 않은 키: ${name}` };
    }
    try {
      await keychain.deletePassword(KEYTAR_SERVICE, name);
      delete process.env[name];
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err && err.message };
    }
  });
}

app.whenReady().then(async () => {
  ensureUserDirs();
  await loadEnvFromKeychain();
  await loadEnvFromFile();
  registerIpc();

  try {
    await startExpressServer();
  } catch (err) {
    console.error('[electron] Express 서버 시작 실패:', err);
    app.quit();
    return;
  }

  buildMenu();
  createWindow();

  // macOS: dock 아이콘 클릭 시 창 다시 열기
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// 모든 창이 닫히면 앱 종료 (Mac도 동일 — 단일 창 도구)
app.on('window-all-closed', () => {
  app.quit();
});
