import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { existsSync, promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sqlite3 from 'sqlite3';
// @ts-expect-error no published types
import dpapi from 'win-dpapi';
import type { CookieParam } from './types.js';

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

export async function loadWindowsCookies(dbPath: string, filterNames?: Set<string>): Promise<CookieParam[]> {
  const localStatePath = await locateLocalState(dbPath);
  const aesKey = await extractWindowsAesKey(localStatePath);
  const rows = await readChromeCookiesDb(dbPath, filterNames);
  const cookies: CookieParam[] = [];
  for (const row of rows) {
    const enc = row.encrypted_value && row.encrypted_value.length > 0 ? row.encrypted_value : Buffer.from(row.value ?? '', 'utf8');
    const decrypted = enc.length > 0 ? decryptCookie(enc, aesKey) : '';
    cookies.push({
      name: row.name,
      value: decrypted,
      domain: row.host_key?.startsWith('.') ? row.host_key.slice(1) : row.host_key,
      path: row.path ?? '/',
      expires: normalizeExpiration(row.expires_utc),
      secure: Boolean(row.is_secure),
      httpOnly: Boolean(row.is_httponly),
    });
  }
  return cookies.filter((c) => c.value);
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
  const unprotected: Buffer = dpapi.unprotectData(value, null, 'CurrentUser');
  return Buffer.from(unprotected).toString('utf8');
}

async function locateLocalState(dbPath: string): Promise<string> {
  // Prefer sibling Local State near the profile path; fall back to default location.
  const guess = path.resolve(path.join(path.dirname(dbPath), '..', 'Local State'));
  if (existsSync(guess)) return guess;
  const localState = path.join(os.homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'User Data', 'Local State');
  if (existsSync(localState)) return localState;
  throw new Error('Chrome Local State not found for AES key');
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

export async function materializeCookieFile(sourcePath: string): Promise<string> {
  if (process.platform !== 'win32') return sourcePath;
  const resolved = await resolveDirectoryCandidate(sourcePath);
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oracle-cookies-'));
  const tempPath = path.join(tempDir, 'Cookies');
  await fs.copyFile(resolved, tempPath);
  return tempPath;
}

async function resolveDirectoryCandidate(inputPath: string): Promise<string> {
  const stat = await fs.stat(inputPath).catch(() => null);
  if (!stat?.isDirectory()) return inputPath;
  const network = path.join(inputPath, 'Network', 'Cookies');
  const direct = path.join(inputPath, 'Cookies');
  if (await fileExists(network)) return network;
  if (await fileExists(direct)) return direct;
  return inputPath;
}

async function fileExists(candidate: string): Promise<boolean> {
  try {
    const stat = await fsp.stat(candidate);
    return stat.isFile();
  } catch {
    return false;
  }
}
