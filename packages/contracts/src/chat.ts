import { z } from "zod";
import { MAX_MESSAGE_CHARS, MAX_HISTORY_TURNS, MAX_HISTORY_CHARS } from "./config.ts";

const nonblank = z.string().refine(value => value.trim().length > 0, "Text must not be blank");
const turnSchema = z.strictObject({ role: z.enum(["user", "assistant"]), content: nonblank });
export const chatInputSchema = z.strictObject({
  message: nonblank.max(MAX_MESSAGE_CHARS),
  history: z.array(turnSchema).max(MAX_HISTORY_TURNS).nullish().transform(value => value ?? []),
}).refine(value => value.history.reduce((size, turn) => size + turn.content.length, 0) <= MAX_HISTORY_CHARS,
  "History exceeds the configured character budget");
export type ChatInput = z.infer<typeof chatInputSchema>;
export const modelAnswerSchema = z.strictObject({
  status: z.enum(["answered", "insufficient_context", "out_of_scope"]),
  answer: nonblank, citations: z.array(z.string()),
});
export interface Evidence {
  id: string;
  chunk_id: string;
  path: string;
  lines: [number, number];
  heading: string | null;
  text: string;
}
