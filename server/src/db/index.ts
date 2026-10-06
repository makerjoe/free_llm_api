import crypto from 'crypto';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { migrateDbSchema } from './migrations.js';
import { encrypt } from '../lib/crypto.js';

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
  // Read individual provider env variables (platform -> env var mappings).
  // Only seeds if api_keys table is empty — never overwrites existing data.
  const providerEnvMap: Record<string, string[]> = {
    google: ['GOOGLE_KEY', 'GOOGLE_API_KEY'],
    groq: ['GROQ_KEY', 'GROQ_API_KEY'],
    openrouter: ['OPENROUTER_KEY', 'OPENROUTER_API_KEY'],
    ollama: ['OLLAMA_API_KEY'],
    opencode: ['OPENCODE_ZEN_API_KEY', 'OPENCODE_API_KEY'],
    openai: ['OPENAI_API_KEY'],
    anthropic: ['ANTHROPIC_API_KEY'],
    cohere: ['COHERE_API_KEY'],
    mistral: ['MISTRAL_API_KEY'],
    cerebras: ['CEREBRAS_API_KEY', 'CEREBRAS_KEY'],
    github: ['GITHUB_KEY', 'GITHUB_API_KEY'],
    cloudflare: ['CLOUDFLARE_KEY', 'CLOUDFLARE_API_KEY'],
    zhipu: ['ZHIPU_API_KEY', 'ZHIPU_KEY'],
    moonshot: ['MOONSHOT_API_KEY', 'MOONSHOT_KEY'],
    minimax: ['MINIMAX_API_KEY', 'MINIMAX_KEY'],
    nvidia: ['NVIDIA_API_KEY', 'NVIDIA_KEY'],
    huggingface: ['HUGGINGFACE_KEY', 'HF_API_KEY', 'HF_KEY'],
    sambanova: ['SAMBANOVA_API_KEY', 'SAMBANOVA_KEY'],
    pollinations: ['POLLINATIONS_KEY', 'POLLINATIONS_API_KEY'],
    llm7: ['LLM7_KEY', 'LLM7_API_KEY'],
    kilo: ['KILO_KEY', 'KILO_API_KEY'],
    custom: ['CUSTOM_API_KEY'],
  };

  const countRow = db.prepare("SELECT COUNT(*) as cnt FROM api_keys").get() as { cnt: number };
  if (countRow.cnt > 0) {
    return;
  }

  const seededPlatforms: string[] = [];
  const insert = db.prepare(`
    INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  for (const [platform, envKeys] of Object.entries(providerEnvMap)) {
    for (const envKey of envKeys) {
      const rawKey = process.env[envKey];
      if (rawKey && rawKey.trim().length > 0) {
        const label = envKey.replace('_API_KEY', '').replace('_KEY', '').toLowerCase();
        const { encrypted, iv, authTag } = encrypt(rawKey.trim());
        insert.run(platform, label, encrypted, iv, authTag, 'unknown', 1);
        seededPlatforms.push(platform);
        break;
      }
    }
  }

  // Also scan any other *_API_KEY or *_KEY variables that don't match the
  // standard map, and seed them under a generic 'custom' platform if they
  // contain a non-empty value, so nothing is lost.
  for (const [envVar, value] of Object.entries(process.env)) {
    if (!envVar || typeof value !== 'string') continue;
    if (envVar === 'DEFAULT_PROVIDERS_JSON') continue;
    if ((envVar.endsWith('_API_KEY') || envVar.endsWith('_KEY')) && value.trim().length > 0) {
      const isStandard = Object.values(providerEnvMap).flat().includes(envVar);
      if (!isStandard && !seededPlatforms.includes('custom')) {
        const { encrypted, iv, authTag } = encrypt(value.trim());
        insert.run('custom', envVar.toLowerCase(), encrypted, iv, authTag, 'unknown', 1);
        seededPlatforms.push('custom');
      }
    }
  }

  if (seededPlatforms.length > 0) {
    console.log(`Auto-seeded providers from env vars: ${seededPlatforms.join(', ')}`);
  }
}
