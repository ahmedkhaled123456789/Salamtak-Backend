import { OpenApiGeneratorV31 } from '@asteasolutions/zod-to-openapi';
import { registry } from '../common/openapi/route';

let cached: ReturnType<OpenApiGeneratorV31['generateDocument']> | undefined;

/** Must be called after all route modules have been imported (they register their paths on import). */
export function buildOpenApiDocument() {
  cached ??= new OpenApiGeneratorV31(registry.definitions).generateDocument({
    openapi: '3.1.0',
    info: {
      title: 'Home Care Marketplace API',
      version: '0.1.0',
      description:
        'Success: `{success:true,data,message}`. Error: `{success:false,message,errorCode}`. Lists return `data:{items,meta:{page,limit,total,totalPages}}`. Money is integer minor units (fils).',
    },
    servers: [{ url: '/' }],
  });
  return cached;
}
