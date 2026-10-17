import { z } from "zod";
export const MAX_DOCUMENT_BYTES = 2_000_000;
export const MAX_DOCUMENTS = 100;
export const MAX_CHUNKS = 1000;
export const CHUNK_SIZE = 1200;
export const CHUNK_OVERLAP = 120;
export const EXTRACTION_RECIPE = "markdown-it-15.0.2-commonmark/utf16-v3";
export const EMBEDDING_RECIPE = "document-path-heading-text-v1";
export const chunkSchema = z.strictObject({
  chunk_id: z.string().regex(/^[a-f0-9]{64}$/),
  document_path: z.string().min(1).refine(path => !path.startsWith("/") && !path.includes("\\")
    && !path.includes("\0") && !/^[a-z]:/i.test(path) && !path.split("/").some(part => part === ".." || part === "." || !part)),
  ordinal: z.number().int().nonnegative().optional(),
  heading: z.string().nullable(),
  line_start: z.number().int().positive(), line_end: z.number().int().positive(),
  text: z.string().min(1).max(CHUNK_SIZE).refine(text => text.trim().length > 0),
}).refine(chunk => chunk.line_end >= chunk.line_start);
export const corpusSchema = z.strictObject({
  recipe: z.string(), chunks: z.array(chunkSchema).min(1).max(MAX_CHUNKS),
}).refine(corpus => new Set(corpus.chunks.map(chunk => chunk.chunk_id)).size === corpus.chunks.length,
  "Duplicate chunk IDs");
export type Corpus = z.infer<typeof corpusSchema>;
export const recipeSchema = z.object({
  corpus: z.string(), embedding_model: z.string(), embedding_recipe: z.string(),
});
