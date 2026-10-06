import crypto from 'crypto';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { migrateDbSchema } from './migrations.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.resolve(__dirname, '../../data/freeapi.db');

let db: Database.Database;

export function getDb(): Database.Database {
  if (!db) {
    throw new Error('Database not initialized. Call initDb() first.');
  }
  return db;
}

export function initDb(dbPath?: string): Database.Database {
  const resolvedPath = dbPath ?? DB_PATH;
  const isMemory = resolvedPath === ':memory:';

  if (!isMemory) {
    const dataDir = path.dirname(resolvedPath);
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
  }

  db = new Database(resolvedPath);
  if (!isMemory) db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  migrateDbSchema(db);
  seedProvidersFromEnv(db);

  console.log(`Database initialized at ${resolvedPath}`);
  return db;
}

export function getUnifiedApiKey(): string {
  if (process.env.UNIFIED_API_KEY) {
    return process.env.UNIFIED_API_KEY;
  }
  const db = getDb();
  const row = db.prepare("SELECT value FROM settings WHERE key = 'unified_api_key'").get() as { value: string };
  return row.value;
}

export function regenerateUnifiedKey(): string {
  const db = getDb();
  const key = `freellmapi-${crypto.randomBytes(24).toString('hex')}`;
  db.prepare("UPDATE settings SET value = ? WHERE key = 'unified_api_key'").run(key);
  return key;
}

// Generic key/value settings accessors (used by routing strategy, etc.).
export function getSetting(key: string): string | undefined {
  const db = getDb();
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value;
}

export function setSetting(key: string, value: string): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, value);
}

function seedProvidersFromEnv(db: Database.Database) {
  const envJson = process.env.DEFAULT_PROVIDERS_JSON;
  if (!envJson || envJson.trim().length === 0) {
    return;
  }
  try {
    const providers = JSON.parse(envJson);
    if (!Array.isArray(providers)) {
      console.warn('DEFAULT_PROVIDERS_JSON is not an array — skipping auto-seed');
      return;
    }
    const countRow = db.prepare("SELECT COUNT(*) as cnt FROM api_keys").get() as { cnt: number };
    if (countRow.cnt > 0) {
      // Table not empty: do not overwrite existing provider configuration
      return;
    }
    const insert = db.prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled, base_url)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const p of providers) {
      const platform = p.platform || p.name || 'unknown';
      const label = p.label || '';
      const encryptedKey = p.encrypted_key || p.encryptedKey || '';
      const iv = p.iv || '';
      const authTag = p.auth_tag || p.authTag || '';
      const status = p.status || 'unknown';
      const enabled = p.enabled === false ? 0 : 1;
      const baseUrl = p.base_url || p.baseUrl || null;
      insert.run(platform, label, encryptedKey, iv, authTag, status, enabled, baseUrl);
    }
    console.log(`Auto-seeded ${providers.length} providers from DEFAULT_PROVIDERS_JSON`);
  } catch (e: any) {
    console.warn('Failed to auto-seed providers from DEFAULT_PROVIDERS_JSON:', e.message);
  }
}
