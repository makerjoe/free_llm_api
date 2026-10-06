import type { Request, Response, NextFunction } from 'express';
import { validateSession } from '../services/auth.js';

// Gate the /api/* admin surface behind a dashboard session (#35, item #2).
// The token is the opaque session token issued by /api/auth/login|setup, sent
// as `Authorization: Bearer *** The /v1 proxy is NOT gated by it — it
// keeps its own unified-API-key auth for app clients.

// ── AUTO-AUTH: bypass login screen ──────────────────────────────────────────
// Para Render (efímero), el dashboard de proveedores debe ser accesible sin
// login. Este mock user se inyecta en cada petición; el frontend nunca ve la
// pantalla de "Sign In".
const MOCK_USER = {
  userId: 1,
  email: 'admin@example.com',
};

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  // Siempre autenticado como mock user — no verifica token ni cookies.
  (req as Request & { user?: typeof MOCK_USER }).user = MOCK_USER;
  next();
}
