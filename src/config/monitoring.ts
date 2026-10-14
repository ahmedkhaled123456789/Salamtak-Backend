import * as Sentry from '@sentry/node';
import { env } from './env';
import { logger } from './logger';

/**
 * Optional error reporting (Sentry), enabled only when SENTRY_DSN is set. Healthcare data must never leave the
 * platform this way, so events are stripped to the error itself: no request bodies, query strings, cookies,
 * headers, IPs or user details — only an opaque request id and (if known) the user's internal id.
 */
let enabled = false;

export function initMonitoring(component: 'api' | 'worker'): void {
  if (!env.SENTRY_DSN || enabled) return;
  Sentry.init({
    dsn: env.SENTRY_DSN,
    environment: env.NODE_ENV,
    initialScope: { tags: { component } },
    sendDefaultPii: false,
    tracesSampleRate: 0, // errors only, no performance tracing
    defaultIntegrations: false,
    integrations: [Sentry.linkedErrorsIntegration(), Sentry.dedupeIntegration(), Sentry.functionToStringIntegration()],
    beforeSend: scrubEvent,
    beforeBreadcrumb: () => null, // breadcrumbs can carry URLs/console text with personal data
  });
  enabled = true;
  logger.info({ component }, 'Error reporting enabled');
}

/** Exported for tests. Keeps only what is needed to fix a bug. */
export function scrubEvent<T extends Sentry.ErrorEvent>(event: T): T {
  if (event.request) {
    const path = event.request.url ? String(event.request.url).split('?')[0] : undefined;
    event.request = { method: event.request.method, url: path };
  }
  event.user = event.user?.id ? { id: String(event.user.id) } : undefined;
  delete event.extra;
  delete event.breadcrumbs;
  if (event.contexts) event.contexts = { runtime: event.contexts.runtime, os: event.contexts.os };
  return event;
}

export function reportError(err: unknown, ctx: { requestId?: string; userId?: string; path?: string } = {}): void {
  if (!enabled) return;
  Sentry.withScope((scope) => {
    if (ctx.requestId) scope.setTag('requestId', ctx.requestId);
    if (ctx.path) scope.setTag('path', ctx.path.split('?')[0]!);
    if (ctx.userId) scope.setUser({ id: ctx.userId });
    Sentry.captureException(err);
  });
}

export async function flushMonitoring(timeoutMs = 2000): Promise<void> {
  if (enabled) await Sentry.flush(timeoutMs).catch(() => undefined);
}
