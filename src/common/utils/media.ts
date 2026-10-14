/** Relative URL of a public image; clients prefix their API origin when it differs from the site's. */
export const mediaUrl = (id: unknown): string | null => (id ? `/api/v1/media/${String(id)}` : null);
