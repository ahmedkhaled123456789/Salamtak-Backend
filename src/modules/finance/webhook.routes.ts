import express, { type Express } from 'express';
import { z } from 'zod';
import { TooManyRequestsError } from '../../common/errors';
import { ErrorResponseSchema, registry } from '../../common/openapi/route';
import { PaymentWebhookService } from './webhook.service';

/**
 * The payment webhook needs the RAW request body for signature verification, so it is mounted in
 * app.ts BEFORE express.json(). It is authenticated by the provider signature only (no JWT).
 */
export function mountPaymentWebhook(app: Express): void {
  app.post(
    '/api/v1/payments/webhook',
    express.raw({ type: () => true, limit: '1mb' }),
    async (req, res, next) => {
      try {
        const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
        const result = await PaymentWebhookService.handle(body, req.headers, req.ip);
        res.status(200).json({ success: true, data: result, message: 'Webhook received' });
      } catch (err) {
        if (err instanceof TooManyRequestsError && err.retryAfterSeconds)
          res.setHeader('Retry-After', String(err.retryAfterSeconds));
        next(err);
      }
    },
  );

  registry.registerPath({
    method: 'post',
    path: '/api/v1/payments/webhook',
    summary: 'Payment provider webhook',
    description:
      'Called by the payment provider, never by clients. Authenticated ONLY by the provider signature over the raw body (`stripe-signature` / `x-mock-signature`: `t=<unix>,v1=<hmac>`). Events are stored first (unique provider+eventId) and applied in one transaction; duplicate deliveries return `DUPLICATE` and change nothing. A failed processing attempt returns 500 so the provider retries.',
    tags: ['Payments'],
    security: [],
    request: {
      body: {
        required: true,
        content: { 'application/json': { schema: z.object({}).passthrough() } },
      },
    },
    responses: {
      200: {
        description: 'Received (processed, ignored or duplicate)',
        content: {
          'application/json': {
            schema: z.object({
              success: z.literal(true),
              data: z.object({
                status: z.enum(['PROCESSED', 'IGNORED', 'DUPLICATE']),
                outcome: z.string(),
              }),
              message: z.string(),
            }),
          },
        },
      },
      400: {
        description: 'Invalid signature',
        content: { 'application/json': { schema: ErrorResponseSchema } },
      },
      409: {
        description: 'Same event is being processed; retry',
        content: { 'application/json': { schema: ErrorResponseSchema } },
      },
      429: {
        description:
          'Too many invalid-signature attempts from this source (valid signed events are never throttled)',
        content: { 'application/json': { schema: ErrorResponseSchema } },
      },
      500: {
        description: 'Processing failed; the provider should retry',
        content: { 'application/json': { schema: ErrorResponseSchema } },
      },
    },
  });
}
