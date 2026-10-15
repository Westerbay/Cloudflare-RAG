import { z } from "zod";
import { DIMENSIONS } from "./config.ts";
export const embeddingResponseSchema = z.object({
  data: z.array(z.array(z.number().finite()).length(DIMENSIONS)
    .refine(vector => vector.some(value => value !== 0))).min(1),
});
