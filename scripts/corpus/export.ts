import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { extname, isAbsolute, join, relative, sep } from "node:path";
import MarkdownIt from "markdown-it";
import { chunkBlocks } from "@small-rag/core/chunking";
import type { ExtractedBlock } from "@small-rag/core/chunking";
import { CHUNK_SIZE, CHUNK_OVERLAP, MAX_DOCUMENT_BYTES, MAX_DOCUMENTS, MAX_CHUNKS,
  corpusSchema } from "@small-rag/contracts/corpus";
import type { Corpus } from "@small-rag/contracts/corpus";
import { EMBEDDING_MODEL } from "@small-rag/contracts/config";

const parser = new MarkdownIt("commonmark");
const hash = (text: string | Uint8Array) => createHash("sha256").update(text).digest("hex");
const MAX_ENTRIES = 5000;

export function extractBlocks(content: string): ExtractedBlock[] {
  const tokens = parser.parse(content, {});
  const headings: string[] = [], blocks: ExtractedBlock[] = [];
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token.type === "heading_open") {
      headings.splice(Number(token.tag.slice(1)) - 1);
      headings.push(plainText(tokens[index + 1]));
    }
    if (!["inline", "fence", "code_block"].includes(token.type) || !token.map) continue;
    const text = plainText(token);
    if (text) blocks.push({ text, line_start: token.map[0] + 1, line_end: token.map[1],
      heading: headings.join(" > ") || null });
  }
  return blocks;
}

function plainText(token: { content: string; children: { type: string; content: string }[] | null }): string {
  if (!token.children?.length) return token.content.trim();
  return token.children.map(child => {
    if (["text", "code_inline", "image"].includes(child.type)) return child.content;
    if (["softbreak", "hardbreak"].includes(child.type)) return "\n";
    return "";
  }).join("").trim();
}

export async function exportCorpus(directory: string): Promise<Corpus> {
  const root = await realpath(directory);
  if (!(await lstat(root)).isDirectory()) throw new Error("Corpus root must be a directory");
  let visited = 0, documents = 0;
  const chunks: Corpus["chunks"] = [];
  async function walk(directory: string): Promise<void> {
    const names = (await readdir(directory)).sort();
    for (const name of names) {
      if (++visited > MAX_ENTRIES) throw new Error("Corpus traversal exceeds 5000 entries");
      const path = join(directory, name), info = await lstat(path);
      // Reject symlinks, including directories, before following or reading any target.
      if (info.isSymbolicLink()) throw new Error("Symlinks are not allowed in the corpus");
      if (info.isDirectory()) { await walk(path); continue; }
      if (![".md", ".markdown"].includes(extname(path).toLowerCase())) continue;
      if (!info.isFile()) throw new Error("Markdown source must be a regular file");
      if (++documents > MAX_DOCUMENTS) throw new Error(`Corpus exceeds ${MAX_DOCUMENTS} documents`);
      const resolved = await realpath(path), documentPath = relative(root, resolved);
      if (isAbsolute(documentPath) || documentPath === ".." || documentPath.startsWith(`..${sep}`)) {
        throw new Error("Source is outside corpus root");
      }
      const file = await open(resolved, constants.O_RDONLY | constants.O_NOFOLLOW);
      let raw: Uint8Array;
      try {
        const bytes = Buffer.alloc(MAX_DOCUMENT_BYTES + 1);
        let size = 0;
        while (size < bytes.length) {
          const read = await file.read(bytes, size, bytes.length - size, null);
          if (!read.bytesRead) break;
          size += read.bytesRead;
        }
        if (size > MAX_DOCUMENT_BYTES) throw new Error(`Markdown source exceeds ${MAX_DOCUMENT_BYTES} bytes`);
        raw = bytes.subarray(0, size);
      } finally { await file.close(); }
      let content: string;
      try { content = new TextDecoder("utf-8", { fatal: true }).decode(raw); }
      catch { throw new Error("Markdown source must be UTF-8"); }
      const sourceHash = hash(raw), sourcePath = documentPath.split(sep).join("/");
      for (const window of chunkBlocks(extractBlocks(content), CHUNK_SIZE, CHUNK_OVERLAP)) {
        chunks.push({ ...window, document_path: sourcePath,
          chunk_id: hash([sourcePath, sourceHash, String(window.ordinal), window.heading ?? "", window.text].join("\0")) });
        if (chunks.length > MAX_CHUNKS) throw new Error(`Corpus exceeds ${MAX_CHUNKS} chunks`);
      }
    }
  }
  await walk(root);
  if (!chunks.length) throw new Error("Corpus has no indexable Markdown chunks");
  // New recipe deliberately requires reindexing instead of mixing Python/parser identities.
  return corpusSchema.parse({ recipe: JSON.stringify({ corpus: "markdown-it-15.0.2-commonmark/utf16-v1",
    embedding_model: EMBEDDING_MODEL, size_chars: CHUNK_SIZE, overlap_chars: CHUNK_OVERLAP }), chunks });
}
