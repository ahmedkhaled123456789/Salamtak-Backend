import type { FilterQuery, Model, PopulateOptions, SortOrder } from 'mongoose';
import { z } from 'zod';

export const paginationQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export type PaginationQuery = z.infer<typeof paginationQuery>;

export interface PageMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}
export interface Page<T> {
  items: T[];
  meta: PageMeta;
}

export async function paginate(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  model: Model<any>,
  filter: FilterQuery<unknown>,
  opts: {
    page: number;
    limit: number;
    sort?: Record<string, SortOrder>;
    select?: string;
    populate?: PopulateOptions;
  },
): Promise<Page<Record<string, unknown>>> {
  const { page, limit } = opts;
  const [items, total] = await Promise.all([
    (opts.populate
      ? model.find(filter, opts.select).populate(opts.populate)
      : model.find(filter, opts.select)
    )
      .sort(opts.sort ?? { createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    model.countDocuments(filter),
  ]);
  return {
    items: items as unknown as Record<string, unknown>[],
    meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
  };
}
