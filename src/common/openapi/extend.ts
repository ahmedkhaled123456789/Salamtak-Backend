import { extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';

// Side-effect module: adds `.openapi()` to zod. Import it before any schema that uses it.
extendZodWithOpenApi(z);
