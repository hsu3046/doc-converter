import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// dist 또는 src 모두에서 동작하도록 templates 디렉토리는 dist/meeting-templates/builtin 또는 src/meeting-templates/builtin 으로 해석
// tsx 실행 시: __dirname = .../src/services → 상위로 가서 meeting-templates/builtin
// 빌드 후: __dirname = .../dist/services → 상위로 가서 meeting-templates/builtin (tsc가 .md를 안 옮기므로 src 절대경로 폴백)
const BUILTIN_CANDIDATES = [
  path.resolve(__dirname, '..', 'meeting-templates', 'builtin'),
  path.resolve(__dirname, '..', '..', 'src', 'meeting-templates', 'builtin'),
];

const USER_DIR = path.join(os.homedir(), '.doc-converter', 'meeting-templates');

const MAX_TEMPLATE_BYTES = 100 * 1024;
const ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

export interface TemplateInfo {
  id: string;
  name: string;
  description: string;
  source: 'builtin' | 'user';
  path: string;
}

export interface LoadedTemplate {
  info: TemplateInfo;
  body: string;
}

async function findBuiltinDir(): Promise<string | null> {
  for (const candidate of BUILTIN_CANDIDATES) {
    try {
      const s = await fs.stat(candidate);
      if (s.isDirectory()) return candidate;
    } catch {
      // 다음 후보
    }
  }
  return null;
}

async function ensureUserDir(): Promise<void> {
  await fs.mkdir(USER_DIR, { recursive: true });
}

/**
 * 단순 frontmatter 파서 — yaml 라이브러리 회피.
 * key: value 한 줄당 1개. 따옴표 자동 제거.
 */
function parseFrontmatter(raw: string): { fm: Record<string, string>; body: string } | null {
  if (!raw.startsWith('---')) return null;
  const endIdx = raw.indexOf('\n---', 3);
  if (endIdx === -1) return null;
  const fmRaw = raw.slice(3, endIdx).trim();
  const body = raw.slice(endIdx + 4).replace(/^\r?\n/, '');

  const fm: Record<string, string> = {};
  for (const line of fmRaw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const colonIdx = trimmed.indexOf(':');
    if (colonIdx === -1) continue;
    const key = trimmed.slice(0, colonIdx).trim();
    let value = trimmed.slice(colonIdx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    fm[key] = value;
  }
  return { fm, body };
}

async function readTemplate(
  filePath: string,
  source: 'builtin' | 'user',
): Promise<LoadedTemplate | null> {
  const raw = await fs.readFile(filePath, 'utf-8');
  const parsed = parseFrontmatter(raw);
  if (!parsed) return null;
  const name = parsed.fm['name']?.trim();
  if (!name) return null;

  const id = path.basename(filePath, path.extname(filePath));
  return {
    info: {
      id,
      name,
      description: parsed.fm['description']?.trim() ?? '',
      source,
      path: filePath,
    },
    body: parsed.body.trim(),
  };
}

async function listFromDir(dir: string, source: 'builtin' | 'user'): Promise<LoadedTemplate[]> {
  let entries: string[] = [];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return [];
  }
  const out: LoadedTemplate[] = [];
  for (const entry of entries) {
    if (!entry.toLowerCase().endsWith('.md')) continue;
    try {
      const t = await readTemplate(path.join(dir, entry), source);
      if (t) out.push(t);
    } catch {
      // skip 잘못된 파일
    }
  }
  return out;
}

export async function listTemplates(): Promise<TemplateInfo[]> {
  await ensureUserDir();
  const builtinDir = await findBuiltinDir();
  const builtinList = builtinDir ? await listFromDir(builtinDir, 'builtin') : [];
  const userList = await listFromDir(USER_DIR, 'user');

  // 같은 id면 user가 우선
  const map = new Map<string, TemplateInfo>();
  for (const t of builtinList) map.set(t.info.id, t.info);
  for (const t of userList) map.set(t.info.id, t.info);

  return Array.from(map.values()).sort((a, b) => {
    if (a.source !== b.source) return a.source === 'builtin' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

export async function getTemplate(idOrPath: string): Promise<LoadedTemplate> {
  // 절대/상대 경로로 직접 들어온 경우 (CLI --template 옵션)
  if (idOrPath.includes('/') || idOrPath.includes('\\')) {
    const t = await readTemplate(path.resolve(idOrPath), 'user');
    if (!t) throw new Error(`템플릿을 읽을 수 없습니다 (frontmatter 또는 name 필드 누락): ${idOrPath}`);
    return t;
  }

  await ensureUserDir();
  // user 디렉토리 우선
  const userPath = path.join(USER_DIR, `${idOrPath}.md`);
  try {
    await fs.access(userPath);
    const t = await readTemplate(userPath, 'user');
    if (t) return t;
  } catch {
    // builtin fallback
  }
  const builtinDir = await findBuiltinDir();
  if (builtinDir) {
    const builtinPath = path.join(builtinDir, `${idOrPath}.md`);
    try {
      await fs.access(builtinPath);
      const t = await readTemplate(builtinPath, 'builtin');
      if (t) return t;
    } catch {
      // not found
    }
  }
  throw new Error(`템플릿을 찾을 수 없습니다: ${idOrPath}`);
}

/**
 * 사용자 .md 파일 저장. 검증 — 크기, frontmatter name, 파일명 sanitize.
 */
export async function saveUserTemplate(filename: string, content: string): Promise<TemplateInfo> {
  await ensureUserDir();

  if (Buffer.byteLength(content, 'utf-8') > MAX_TEMPLATE_BYTES) {
    throw new Error(`템플릿 파일이 ${MAX_TEMPLATE_BYTES / 1024}KB를 초과합니다.`);
  }

  const baseRaw = path.basename(filename, path.extname(filename));
  // path traversal/특수문자 차단
  if (!ID_PATTERN.test(baseRaw)) {
    throw new Error(
      `템플릿 파일명은 영문/숫자/하이픈/언더스코어만 사용 가능합니다 (입력: ${baseRaw}).`,
    );
  }

  const parsed = parseFrontmatter(content);
  if (!parsed) {
    throw new Error('템플릿에 frontmatter 가 없습니다. (--- name: ... --- 블록 필수)');
  }
  if (!parsed.fm['name']?.trim()) {
    throw new Error('frontmatter 에 name 필드가 필요합니다.');
  }

  const targetPath = path.join(USER_DIR, `${baseRaw}.md`);
  await fs.writeFile(targetPath, content, 'utf-8');

  const t = await readTemplate(targetPath, 'user');
  if (!t) throw new Error('템플릿 저장 후 재로딩 실패');
  return t.info;
}

export function getUserTemplateDir(): string {
  return USER_DIR;
}
