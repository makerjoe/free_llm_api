import './env.js';
import { createApp } from './app.js';
import { initDb, getSetting } from './db/index.js';
import { startHealthChecker } from './services/health.js';
import { applyProxyUrl, applyProxyEnabled, applyProxyBypass } from './lib/proxy.js';
import { startCatalogSync } from './services/catalog-sync.js';
import { installProcessSafetyNet } from './lib/process-safety-net.js';
import { userCount, createSession, createUser } from './services/auth.js';
import crypto from 'crypto';

const PORT = process.env.PORT ?? 3001;
// Dual-stack ('::') by default so the dashboard is reachable over both IPv4
// and IPv6 (e.g. IPv6-enabled Docker networks — #180). Hosts with IPv6
// disabled fall back to IPv4-only below; HOST overrides the default outright.
const HOST = process.env.HOST ?? '::';

async function main() {
  // Install first so a late provider socket reset (undici HTTP/2 error with no
  // listener) can't take the proxy down. Genuine bugs still exit 1.
  installProcessSafetyNet();

  initDb();

  // ── Auto-init: si no hay usuarios, insertar uno por defecto silenciosamente ──
  // Esto evita la pantalla de "Create your account" tras cada reinicio/despliegue
  // en Render (arquitectura de disco efímero). El usuario es preconfigurado y
  // la contraseña se deriva de ENCRYPTION_KEY o usa un hash por defecto.
  if (userCount() === 0) {
    // Intentar usar una contraseña desde env, o una por defecto si no hay ENCRYPTION_KEY
    const defaultPassword = process.env.DEFAULT_PASSWORD || 'default-password';
    try {
      const user = createUser('admin@example.com', defaultPassword);
      const token = createSession(user.userId);
      console.log('[auto-init] Usuario por defecto creado: ' + user.email);
      console.log('[auto-init] Token inicial generado');
    } catch (err: any) {
      // Si el usuario ya existe (race condition) o la contraseña es inválida, continuar
      console.log('[auto-init] No fue posible crear usuario por defecto:', err.message ?? err);
    }
  }
  // --------------------------------------------------------------

  // Load the persisted proxy settings from the DB (env var wins if set).
  // Must happen after initDb so the settings table is ready.
  applyProxyUrl(getSetting('proxy_url') ?? '');
  applyProxyEnabled(getSetting('proxy_enabled') !== '0'); // default: enabled
  applyProxyBypass(getSetting('proxy_bypass') ?? '');

  const app = createApp();

  const onReady = (host: string) => () => {
    const display = host.includes(':') ? `[${host}]` : host;
    console.log(`Server running on http://${display}:${PORT}`);
    console.log(`Proxy endpoint: http://${display}:${PORT}/v1/chat/completions`);
    startHealthChecker();
    startCatalogSync();
  };

  const server = app.listen(Number(PORT), HOST, onReady(HOST));
  server.on('error', (err: NodeJS.ErrnoException) => {
    // The default '::' bind fails where IPv6 is disabled (kernel
    // ipv6.disable=1 and the like) — retry IPv4-only rather than dying.
    // Anything else (EADDRINUSE, an explicit HOST that can't bind) keeps the
    // fail-fast posture documented in main().catch below.
    if (!process.env.HOST && (err.code === 'EAFNOSUPPORT' || err.code === 'EADDRNOTAVAIL')) {
      console.warn('[server] IPv6 unavailable on this host — falling back to 0.0.0.0 (IPv4-only)');
      app.listen(Number(PORT), '0.0.0.0', onReady('0.0.0.0'));
      return;
    }
    console.error('\n[server] Failed to start:\n  ' + (err?.message ?? err) + '\n');
    process.exit(1);
  });
}

main().catch((err) => {
  // A boot failure (e.g. a missing production ENCRYPTION_KEY) must exit
  // non-zero rather than leaving a half-initialized process that never starts
  // listening — that silent state is what surfaces in the client as
  // "Can't reach the server".
  console.error('\n[server] Failed to start:\n  ' + (err?.message ?? err) + '\n');
  process.exit(1);
});
