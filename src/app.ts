import { randomUUID } from 'node:crypto';
import cors from 'cors';
import express, { type Express } from 'express';
import helmet from 'helmet';
import mongoose from 'mongoose';
import pinoHttp from 'pino-http';
import swaggerUi from 'swagger-ui-express';
import { env } from './config/env';
import { logger } from './config/logger';
import { pingRedis } from './config/redis';
import { buildOpenApiDocument } from './config/swagger';
import { errorHandler, notFoundHandler } from './common/middleware/errorHandler';
import { limits, rateLimit } from './common/middleware/rateLimit';
import { rejectUnsafeKeys } from './common/middleware/sanitize';
import { mountPaymentWebhook, registerFinancialHooks } from './modules/finance';
import { registerCouponHooks } from './modules/coupons';
import { registerNotificationHooks } from './modules/notifications';
import { apiRouter } from './routes';
import { cronSweep } from './jobs/cron.route';

export function createApp(): Express {
  registerFinancialHooks();
  registerNotificationHooks();
  registerCouponHooks();
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', env.TRUST_PROXY);

  app.use(
    pinoHttp({
      logger,
      genReqId: (req, res) => {
        const incoming = req.headers['x-request-id'];
        const id = typeof incoming === 'string' && incoming.length <= 100 ? incoming : randomUUID();
        res.setHeader('x-request-id', id);
        return id;
      },
      // Only safe, structured fields: requestId, method, url path, status, duration (+ user id).
      serializers: {
        req: (req) => ({ id: req.id, method: req.method, url: String(req.url).split('?')[0] }),
        res: (res) => ({ statusCode: res.statusCode }),
      },
      customProps: (req) => ({
        userId: (req as unknown as { auth?: { userId: string } }).auth?.userId,
      }),
      autoLogging: { ignore: (req) => req.url === '/health' },
      quietReqLogger: true,
    }),
  );

  app.use(helmet());
  app.use(
    cors({
      origin: env.corsOrigins.length ? env.corsOrigins : false,
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
      allowedHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key', 'X-Request-Id'],
      maxAge: 600,
    }),
  );

  // The payment webhook needs the raw body for signature verification: mounted BEFORE express.json().
  mountPaymentWebhook(app);
  app.use(express.json({ limit: '100kb' }));
  app.use(rejectUnsafeKeys);
  app.use(rateLimit('global', limits.global));

  app.get('/health', (_req, res) => {
    res.json({ success: true, data: { status: 'ok' }, message: 'Success' });
  });
  app.get('/health/ready', async (_req, res) => {
    const mongoOk = mongoose.connection.readyState === 1;
    const redisOk = await pingRedis();
    const ready = mongoOk && redisOk;
    res.status(ready ? 200 : 503).json({
      success: ready,
      data: { mongo: mongoOk, redis: redisOk },
      message: ready ? 'Ready' : 'Not ready',
    });
  });

  if (env.swaggerEnabled) {
    const doc = buildOpenApiDocument();
    app.get('/docs.json', (_req, res) => {
      res.json(doc);
    });
    app.use('/docs', swaggerUi.serve, swaggerUi.setup(doc, { customSiteTitle: 'Care API Docs' }));
  }

  // scheduled sweeps for hosts without long-running workers (needs CRON_SECRET; see jobs/cron.route.ts)
  app.get('/internal/cron/sweep', cronSweep);
  app.post('/internal/cron/sweep', cronSweep);

  app.use('/api/v1', apiRouter);
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
