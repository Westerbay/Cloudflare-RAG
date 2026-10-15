/** Pure source-linked windows. Filesystem, hashing and provider details stay outside core. */
export interface ExtractedBlock {
  text: string;
  line_start: number;
  line_end: number;
  heading: string | null;
}
export interface ChunkWindow extends ExtractedBlock { ordinal: number }

export function chunkBlocks(blocks: ExtractedBlock[], size: number, overlap: number): ChunkWindow[] {
  if (!Number.isInteger(size) || size < 2 || !Number.isInteger(overlap) || overlap < 0 || overlap >= size) {
    throw new Error("Chunk size must be at least two and overlap smaller than size");
  }
  const sections: { heading: string | null; blocks: ExtractedBlock[] }[] = [];
  for (const block of blocks) {
    let section = sections.at(-1);
    if (!section || section.heading !== block.heading) {
      section = { heading: block.heading, blocks: [] }; sections.push(section);
    }
    section.blocks.push(block);
  }
  const chunks: ChunkWindow[] = [];
  for (const section of sections) {
    const text = section.blocks.map(block => block.text).join("\n\n");
    let offset = 0;
    const spans = section.blocks.map(block => {
      const span = { start: offset, end: offset + block.text.length, block };
      offset += block.text.length + 2;
      return span;
    });
    let start = 0;
    while (start < text.length) {
      let end = Math.min(start + size, text.length);
      // Do not split a UTF-16 surrogate pair at either edge of an overlapping window.
      if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end--;
      const window = text.slice(start, end);
      if (window.trim()) {
        const touched = spans.filter(span => span.start < end && span.end > start);
        chunks.push({ text: window, heading: section.heading, ordinal: chunks.length,
          line_start: Math.min(...touched.map(span => span.block.line_start)),
          line_end: Math.max(...touched.map(span => span.block.line_end)) });
      }
      if (end === text.length) break;
      let next = Math.max(start + 1, end - overlap);
      if (/[\uDC00-\uDFFF]/.test(text[next])) next++;
      start = next;
    }
  }
  return chunks;
}
