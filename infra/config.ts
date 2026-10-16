import { z } from "zod";
export const cloudflareConfigSchema = z.looseObject({
  account_id: z.string().optional(),
  d1_databases: z.array(z.looseObject({
    binding: z.string().optional(), database_name: z.string().optional(), database_id: z.string(),
  })).min(1),
  vectorize: z.array(z.looseObject({ binding: z.string().optional(), index_name: z.string() })).min(1),
});
