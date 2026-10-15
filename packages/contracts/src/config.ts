// Model IDs are deliberately fixed: switching models is a reviewed code change.
export const CHAT_MODEL = "@cf/meta/llama-3.1-8b-instruct-fp8";
export const EMBEDDING_MODEL = "@cf/qwen/qwen3-embedding-0.6b";
export const DIMENSIONS = 1024;
export const MAX_OUTPUT_TOKENS = 200;
export const TOP_K = 4;
export const MAX_EVIDENCE_CHARS = 3000;
export const MAX_MESSAGE_CHARS = 1500;
export const MAX_HISTORY_TURNS = 4;
export const MAX_HISTORY_CHARS = 2000;
export const MAX_BODY_BYTES = 16_384;

export function similarityThreshold(value = "0.4"): number {
  const threshold = Number(value);
  if (!value.trim() || !Number.isFinite(threshold) || threshold < -1 || threshold > 1) {
    throw new Error("MIN_SIMILARITY must be between -1 and 1");
  }
  return threshold;
}
