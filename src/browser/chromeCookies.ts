import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import chromeCookies from 'chrome-cookies-secure';
import { COOKIE_URLS } from './constants.js';
import type { CookieParam } from './types.js';
import './keytarShim.js';
import { loadWindowsCookies, materializeCookieFile } from './windowsCookies.js';

type KeychainLabel = { service: string; account: string };
type KeytarLike = { getPassword: (service: string, account: string) => Promise<string | null> };

const COOKIE_READ_TIMEOUT_MS = readDuration('ORACLE_COOKIE_LOAD_TIMEOUT_MS', 5_000);
const KEYCHAIN_PROBE_TIMEOUT_MS = readDuration('ORACLE_KEYCHAIN_PROBE_TIMEOUT_MS', 3_000);
const MAC_KEYCHAIN_LABELS = loadKeychainLabels();

export interface LoadChromeCookiesOptions {
  targetUrl: string;
  profile?: string | null;
  explicitCookiePath?: string | null;
  filterNames?: Set<string>;
}

export async function loadChromeCookies({
  targetUrl,
  profile,
  explicitCookiePath,
  filterNames,
}: LoadChromeCookiesOptions): Promise<CookieParam[]> {
  const urlsToCheck = Array.from(new Set([stripQuery(targetUrl), ...COOKIE_URLS]));
  const merged = new Map<string, CookieParam>();
  const cookieFile = await resolveCookieFilePath({ explicitPath: explicitCookiePath, profile });
  const cookiesPath = await materializeCookieFile(cookieFile);
  if (process.env.ORACLE_DEBUG_COOKIES === '1') {
    // Debug helper: surface which cookie DB path we attempt to read.
    // eslint-disable-next-line no-console
    console.log(`[cookies] resolved cookie path: ${cookiesPath}`);
  }

  // Windows: chrome-cookies-secure sometimes returns empty values for modern AES-GCM cookies.
  // Try native decrypt first; fall back to the cross-platform helper if it fails.
  if (process.platform === 'win32') {
    try {
      const winCookies = await loadWindowsCookies(cookiesPath, filterNames);
      if (winCookies.length) {
        for (const cookie of winCookies) {
          const key = `${cookie.domain}:${cookie.name}`;
          merged.set(key, cookie);
        }
        return Array.from(merged.values());
      }
    } catch (error) {
      if (process.env.ORACLE_DEBUG_COOKIES === '1') {
        // eslint-disable-next-line no-console
        console.log(`[cookies] windows decrypt failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  await ensureMacKeychainReadable();

  for (const url of urlsToCheck) {
    let raw: unknown;
    try {
      raw = await settleWithTimeout(
        chromeCookies.getCookiesPromised(url, 'puppeteer', cookiesPath),
        COOKIE_READ_TIMEOUT_MS,
        `Timed out reading Chrome cookies from ${cookiesPath} (after ${COOKIE_READ_TIMEOUT_MS} ms)`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to load Chrome cookies for ${url}: ${message}`);
    }
    if (!Array.isArray(raw)) continue;
    const fallbackHost = new URL(url).hostname;
    for (const cookie of raw) {
      if (filterNames && filterNames.size > 0 && !filterNames.has(cookie.name)) continue;
      const normalized = normalizeCookie(cookie, fallbackHost);
      if (!normalized) continue;
      const key = `${normalized.domain ?? fallbackHost}:${normalized.name}`;
      if (!merged.has(key)) {
        merged.set(key, normalized);
      }
    }
  }
  return Array.from(merged.values());
}

async function ensureMacKeychainReadable(): Promise<void> {
  if (process.platform !== 'darwin') {
    return;
  }
  // chrome-cookies-secure can hang forever when macOS Keychain rejects access (e.g., SSH/no GUI).
  // Probe the keychain ourselves with a timeout so callers fail fast instead of blocking the run.
  const keytarModule = await import('keytar');
  const keytar = (keytarModule.default ?? keytarModule) as KeytarLike;
  const password = await settleWithTimeout(
    findKeychainPassword(keytar, MAC_KEYCHAIN_LABELS),
    KEYCHAIN_PROBE_TIMEOUT_MS,
    `Timed out reading macOS Keychain while looking up Chrome Safe Storage (after ${KEYCHAIN_PROBE_TIMEOUT_MS} ms). Unlock the login keychain or start oracle serve from a GUI session.`,
  );
  if (!password) {
    throw new Error(
      'macOS Keychain denied access to Chrome cookies. Unlock the login keychain or run oracle serve from a GUI session, then retry.',
    );
  }
}

async function findKeychainPassword(keytar: KeytarLike, labels: KeychainLabel[]): Promise<string | null> {
  let lastError: Error | null = null;
  for (const label of labels) {
    try {
      const value = await keytar.getPassword(label.service, label.account);
      if (value) return value;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
  }
  if (lastError) {
    throw lastError;
  }
  return null;
}

function settleWithTimeout<T>(promise: Promise<T>, timeoutMs: number, timeoutMessage: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function normalizeCookie(
  cookie: {
    name?: string;
    value?: string;
    domain?: string;
    path?: string;
    expires?: number;
    // biome-ignore lint/style/useNamingConvention: mirrors chromium column names
    'Secure'?: boolean;
    // biome-ignore lint/style/useNamingConvention: mirrors chromium column names
    'HttpOnly'?: boolean;
  },
  fallbackHost: string,
): CookieParam | null {
  if (!cookie?.name) return null;
  const domain = cookie.domain?.startsWith('.') ? cookie.domain.slice(1) : cookie.domain ?? fallbackHost;
  const expires = normalizeExpiration(cookie.expires);
  const secure = typeof cookie.Secure === 'boolean' ? cookie.Secure : true;
  const httpOnly = typeof cookie.HttpOnly === 'boolean' ? cookie.HttpOnly : false;
  return {
    name: cookie.name,
    value: cleanValue(cookie.value ?? ''),
    domain,
    path: cookie.path ?? '/',
    expires,
    secure,
    httpOnly,
  };
}

function cleanValue(value: string): string {
  let i = 0;
  while (i < value.length && value.charCodeAt(i) < 0x20) i += 1;
  return value.slice(i);
}

function normalizeExpiration(expires?: number): number | undefined {
  if (!expires || Number.isNaN(expires)) {
    return undefined;
  }
  const value = Number(expires);
  if (value <= 0) return undefined;
  if (value > 1_000_000_000_000) {
    return Math.round(value / 1_000_000 - 11644473600);
  }
  if (value > 1_000_000_000) {
    return Math.round(value / 1000);
  }
  return Math.round(value);
}

async function resolveCookieFilePath({
  explicitPath,
  profile,
}: {
  explicitPath?: string | null;
  profile?: string | null;
}): Promise<string> {
  if (explicitPath && explicitPath.trim().length > 0) {
    return ensureCookieFile(explicitPath);
  }
  if (profile && looksLikePath(profile)) {
    return ensureCookieFile(profile);
  }
  const profileName = profile && profile.trim().length > 0 ? profile : 'Default';
  const baseDir = await defaultProfileRoot();
  return ensureCookieFile(path.join(baseDir, profileName));
}

async function ensureCookieFile(inputPath: string): Promise<string> {
  const expanded = expandPath(inputPath);
  const stat = await fs.stat(expanded).catch(() => null);
  if (!stat) {
    throw new Error(`Unable to locate Chrome cookie DB at ${expanded}`);
  }
  if (stat.isDirectory()) {
    const directFile = path.join(expanded, 'Cookies');
    if (await fileExists(directFile)) return directFile;
    const networkFile = path.join(expanded, 'Network', 'Cookies');
    if (await fileExists(networkFile)) return networkFile;
    throw new Error(`No Cookies DB found under ${expanded}`);
  }
  return expanded;
}

async function fileExists(candidate: string): Promise<boolean> {
  try {
    const stat = await fs.stat(candidate);
    return stat.isFile();
  } catch {
    return false;
  }
}

function expandPath(input: string): string {
  if (input.startsWith('~/')) {
    return path.join(os.homedir(), input.slice(2));
  }
  return path.isAbsolute(input) ? input : path.resolve(process.cwd(), input);
}

function looksLikePath(value: string): boolean {
  return value.includes('/') || value.includes('\\');
}

async function loadWindowsCookies(dbPath: string, filterNames?: Set<string>): Promise<CookieParam[]> {
  const localState = await locateLocalState();
  const aesKey = await extractWindowsAesKey(localState);
  const rows = await readChromeCookiesDb(dbPath, filterNames);
  const cookies: CookieParam[] = [];
  for (const row of rows) {
    const valueBuf: Buffer =
      row.encrypted_value && row.encrypted_value.length > 0
        ? row.encrypted_value
        : Buffer.from(row.value ?? '', 'utf8');
    const decrypted = valueBuf.length > 0 ? decryptCookie(valueBuf, aesKey) : '';
    cookies.push({
      name: row.name,
      value: cleanValue(decrypted),
      domain: row.host_key?.startsWith('.') ? row.host_key.slice(1) : row.host_key,
      path: row.path ?? '/',
      expires: normalizeExpiration(row.expires_utc),
      secure: Boolean(row.is_secure),
      httpOnly: Boolean(row.is_httponly),
    });
  }
  return cookies.filter((c) => c.value);
}

async function locateLocalState(): Promise<string> {
  const localState = path.join(os.homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'User Data', 'Local State');
  const exists = await fileExists(localState);
  if (!exists) throw new Error('Chrome Local State not found for AES key');
  return localState;
}

async function extractWindowsAesKey(localStatePath: string): Promise<Buffer> {
  const raw = await fs.readFile(localStatePath, 'utf8');
  const state = JSON.parse(raw);
  const encKeyB64: string | undefined = state?.os_crypt?.encrypted_key;
  if (!encKeyB64) throw new Error('encrypted_key missing in Local State');
  const encKey = Buffer.from(encKeyB64, 'base64');
  const dpapiBlob = encKey.slice(5); // strip "DPAPI"
  const unprotected: Buffer = dpapi.unprotectData(dpapiBlob, null, 'CurrentUser');
  return Buffer.from(unprotected);
}

function decryptCookie(value: Buffer, aesKey: Buffer): string {
  const prefix = value.slice(0, 3).toString();
  if (prefix === 'v10' || prefix === 'v11') {
    const iv = value.slice(3, 15);
    const tag = value.slice(value.length - 16);
    const data = value.slice(15, value.length - 16);
    const decipher = crypto.createDecipheriv('aes-256-gcm', aesKey, iv);
    decipher.setAuthTag(tag);
    const decrypted = Buffer.concat([decipher.update(data), decipher.final()]);
    return decrypted.toString('utf8');
  }
  // Legacy DPAPI blob
  const unprotected: Buffer = dpapi.unprotectData(value, null, 'CurrentUser');
  return Buffer.from(unprotected).toString('utf8');
}

type RawCookieRow = {
  name: string;
  value: string;
  encrypted_value: Buffer;
  host_key: string;
  path: string;
  expires_utc: number;
  is_secure: number;
  is_httponly: number;
};

async function readChromeCookiesDb(dbPath: string, filterNames?: Set<string>): Promise<RawCookieRow[]> {
  const db = await openSqlite(dbPath);
  const placeholders =
    filterNames && filterNames.size > 0 ? `AND name IN (${Array.from(filterNames).map(() => '?').join(',')})` : '';
  const params = filterNames ? Array.from(filterNames) : [];
  const sql = `SELECT name,value,encrypted_value,host_key,path,expires_utc,is_secure,is_httponly FROM cookies WHERE host_key LIKE '%chatgpt.com%' ${placeholders}`;
  try {
    return await allSqlite<RawCookieRow>(db, sql, params);
  } finally {
    db.close();
  }
}

function openSqlite(dbPath: string): Promise<sqlite3.Database> {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READONLY, (err) => {
      if (err) reject(err);
      else resolve(db);
    });
  });
}

function allSqlite<T>(db: sqlite3.Database, sql: string, params: unknown[]): Promise<T[]> {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve((rows ?? []) as T[]);
    });
  });
}

async function defaultProfileRoot(): Promise<string> {
  const candidates: string[] = [];
  if (process.platform === 'darwin') {
    candidates.push(
      path.join(os.homedir(), 'Library', 'Application Support', 'Google', 'Chrome'),
      path.join(os.homedir(), 'Library', 'Application Support', 'Microsoft Edge'),
      path.join(os.homedir(), 'Library', 'Application Support', 'Chromium'),
    );
  } else if (process.platform === 'linux') {
    candidates.push(
      path.join(os.homedir(), '.config', 'google-chrome'),
      path.join(os.homedir(), '.config', 'microsoft-edge'),
      path.join(os.homedir(), '.config', 'chromium'),
    );
  } else if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local');
    candidates.push(
      path.join(localAppData, 'Google', 'Chrome', 'User Data'),
      path.join(localAppData, 'Microsoft', 'Edge', 'User Data'),
      path.join(localAppData, 'Chromium', 'User Data'),
    );
  } else {
    throw new Error(`Unsupported platform: ${process.platform}`);
  }

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  // fallback: first candidate even if missing; upstream will throw clearer error
  return candidates[0];
}

function stripQuery(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = '';
    parsed.search = '';
    return parsed.toString();
  } catch {
    return url;
  }
}

function readDuration(envKey: string, fallback: number): number {
  const raw = process.env[envKey];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function loadKeychainLabels(): KeychainLabel[] {
  const defaults: KeychainLabel[] = [
    { service: 'Chrome Safe Storage', account: 'Chrome' },
    { service: 'Chromium Safe Storage', account: 'Chromium' },
    { service: 'Microsoft Edge Safe Storage', account: 'Microsoft Edge' },
    { service: 'Brave Safe Storage', account: 'Brave' },
    { service: 'Vivaldi Safe Storage', account: 'Vivaldi' },
  ];
  const rawEnv = process.env.ORACLE_KEYCHAIN_LABELS;
  if (!rawEnv) return defaults;
  try {
    const parsed = JSON.parse(rawEnv);
    if (!Array.isArray(parsed)) return defaults;
    const envLabels = parsed
      .map((entry) => (entry && typeof entry === 'object' ? entry : null))
      .filter((entry): entry is KeychainLabel => Boolean(entry?.service && entry?.account));
    return envLabels.length ? [...envLabels, ...defaults] : defaults;
  } catch {
    return defaults;
  }
}

// biome-ignore lint/style/useNamingConvention: test-only export used in vitest suite
export const __test__ = {
  normalizeExpiration,
  cleanValue,
  looksLikePath,
  defaultProfileRoot,
};
