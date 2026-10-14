import type { Role } from '../constants/rbac';

declare global {
  namespace Express {
    interface AuthContext {
      userId: string;
      role: Role;
    }
    interface Request {
      auth?: AuthContext;
      /** Zod-parsed request parts (Express 5 makes req.query read-only). */
      valid: { body?: unknown; query?: unknown; params?: unknown; headers?: unknown };
    }
  }
}
export {};
