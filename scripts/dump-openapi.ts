/** Writes the generated OpenAPI document to stdout (used for external validation in CI). */
import '../src/routes'; // registers every route's OpenAPI definition
import { buildOpenApiDocument } from '../src/config/swagger';

process.stdout.write(JSON.stringify(buildOpenApiDocument(), null, 2));
