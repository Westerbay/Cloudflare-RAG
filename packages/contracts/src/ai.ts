import { z } from "zod";
import { DIMENSIONS, MAX_MESSAGE_CHARS } from "./config.ts";
export const embeddingResponseSchema = z.object({
  data: z.array(z.array(z.number().finite()).length(DIMENSIONS)
    .refine(vector => vector.some(value => value !== 0))).min(1),
});

export const retrievalQuestionSchema = z.strictObject({
  question: z.string().min(1).max(MAX_MESSAGE_CHARS)
    .refine(value => value.trim().length > 0, "Search question must not be blank"),
});
