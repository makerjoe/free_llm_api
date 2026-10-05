// Auto-rehydration script for FreeLLMAPI Render (db/index.js)
// Idempotent, safe, no secrets shown, reads process.env only.
const crypto = require('crypto');
const fs = require('fs');
const Database = require('better-sqlite3');

function initDbAutoRehydrate(dbPath) {
  try {
    const db = new Database(dbPath || ':memory:');
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');

    const unifiedKey = process.env.UNIFIED_API_KEY || null;
    if (unifiedKey && unifiedKey.trim().length > 0) {
      db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('unified_api_key', ?)").run(unifiedKey.trim());
      console.log('[auto-rehydrate] Unified API key injected');
    } else {
      console.log('[auto-rehydrate] UNIFIED_API_KEY missing — skipping');
    }

    const providers = { 
      google: process.env.GOOGLE_KEY, 
      groq: process.env.GROQ_KEY, 
      ollama: process.env.OLLAMA_API_KEY, 
      opencode: process.env.OPENCODE_ZEN_API_KEY, 
      openrouter: process.env.OPENROUTER_KEY 
    };
    const encKey = process.env.ENCRYPTION_KEY || (process.env.NODE_ENV !== 'production' ? crypto.randomBytes(32).toString('hex') : null);
    if (!encKey && process.env.NODE_ENV === 'production') { 
      console.error('[auto-rehydrate] ENCRYPTION_KEY missing'); 
      return db; 
    }
    if (encKey && encKey !== 'your-64-char-hex-key-here' && encKey.length === 64) {
      for (const [platform, rawKey] of Object.entries(providers)) {
        if (rawKey && rawKey.trim().length > 0) {
          const existing = db.prepare('SELECT id FROM api_keys WHERE platform = ? LIMIT 1').get(platform);
          if (!existing) {
            const iv = crypto.randomBytes(16);
            const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(encKey, 'hex'), iv);
            let encrypted = cipher.update(rawKey.trim(), 'utf8', 'hex');
            encrypted += cipher.final('hex');
            const authTag = cipher.getAuthTag().toString('hex');
            db.prepare('INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled) VALUES (?, ?, ?, ?, ?, ?, 1)').run(platform, platform, encrypted, iv.toString('hex'), authTag, 'unknown');
            console.log('[auto-rehydrate] Provider ' + platform + ' injected');
          } else { 
            console.log('[auto-rehydrate] Provider ' + platform + ' already configured'); 
          }
        }
      }
    } else { 
      console.log('[auto-rehydrate] ENCRYPTION_KEY missing or invalid — provider injection skipped'); 
    }
    return db;
  } catch (err) { 
    console.error('[auto-rehydrate] Error:', err.message); 
  }
}

module.exports = { initDbAutoRehydrate };
