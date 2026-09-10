import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { embedText } from "./embeddings.js";

export interface CorpusDocMeta {
  document_id: string;
  title: string;
  version: string;
  status: "current" | "superseded" | "untrusted";
  effective_date?: string;
}

export interface CorpusChunk extends CorpusDocMeta {
  chunk_id: string;
  page_or_section?: string;
  text: string;
  // Populated by embedCorpusChunks — absent right after loadCorpusChunks,
  // since chunking is pure/local but embedding needs a Bedrock call.
  embedding?: number[];
}

function parseFrontmatter(raw: string): { meta: Record<string, string>; body: string } {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) {
    throw new Error("Corpus document missing YAML frontmatter block");
  }
  const [, frontmatter, body] = match;
  const meta: Record<string, string> = {};
  for (const line of frontmatter.split("\n")) {
    const colonIndex = line.indexOf(":");
    if (colonIndex === -1) continue;
    const key = line.slice(0, colonIndex).trim();
    const value = line.slice(colonIndex + 1).trim();
    meta[key] = value;
  }
  return { meta, body: body.trim() };
}

function chunkBySection(body: string): { heading: string; text: string }[] {
  const sections = body.split(/\n(?=## )/g);
  return sections
    .map((section) => {
      const headingMatch = section.match(/^## (.+)$/m);
      return {
        heading: headingMatch ? headingMatch[1].trim() : "intro",
        text: section.trim(),
      };
    })
    .filter((s) => s.text.length > 0);
}

// Bedrock Titan-style status mapping isn't in the frontmatter for every doc
// (e.g. the superseded/adversarial fixtures encode it directly), so this
// normalizes on the explicit `status` field where present.
function normalizeStatus(raw: string | undefined): CorpusDocMeta["status"] {
  if (raw === "superseded" || raw === "untrusted") return raw;
  return "current";
}

export async function loadCorpusChunks(corpusDir: string): Promise<CorpusChunk[]> {
  const files = (await readdir(corpusDir)).filter((f) => f.endsWith(".md"));
  const chunks: CorpusChunk[] = [];

  for (const file of files) {
    const raw = await readFile(path.join(corpusDir, file), "utf-8");
    const { meta, body } = parseFrontmatter(raw);
    const docMeta: CorpusDocMeta = {
      document_id: meta.document_id ?? file.replace(/\.md$/, ""),
      title: meta.title ?? file,
      version: meta.version ?? "1.0",
      status: normalizeStatus(meta.status),
      effective_date: meta.effective_date,
    };

    const sections = chunkBySection(body);
    sections.forEach((section, i) => {
      chunks.push({
        ...docMeta,
        chunk_id: `${docMeta.document_id}#${i}`,
        page_or_section: section.heading,
        text: section.text,
      });
    });
  }

  return chunks;
}

export async function writeChunksToFile(chunks: CorpusChunk[], outPath: string): Promise<void> {
  await writeFile(outPath, JSON.stringify(chunks, null, 2), "utf-8");
}

function chunkContentHash(chunk: CorpusChunk): string {
  return createHash("sha256").update(chunk.text).digest("hex");
}

// Computes a real Bedrock embedding for each chunk, one call per chunk not
// already cached. Cache key is chunk_id + a hash of its text, so editing a
// corpus document only re-embeds the changed chunks, not the whole corpus
// — the embed calls are cheap individually but there's no reason to repeat
// them for content that hasn't changed.
export async function embedCorpusChunks(
  chunks: CorpusChunk[],
  cache: Map<string, { hash: string; embedding: number[] }> = new Map(),
): Promise<CorpusChunk[]> {
  const embedded: CorpusChunk[] = [];
  for (const chunk of chunks) {
    const hash = chunkContentHash(chunk);
    const cached = cache.get(chunk.chunk_id);
    if (cached && cached.hash === hash) {
      embedded.push({ ...chunk, embedding: cached.embedding });
      continue;
    }
    const embedding = await embedText(chunk.text);
    cache.set(chunk.chunk_id, { hash, embedding });
    embedded.push({ ...chunk, embedding });
  }
  return embedded;
}

interface EmbeddingCacheFile {
  entries: { chunk_id: string; hash: string; embedding: number[] }[];
}

export async function loadEmbeddingCache(
  cachePath: string,
): Promise<Map<string, { hash: string; embedding: number[] }>> {
  try {
    const raw = await readFile(cachePath, "utf-8");
    const file: EmbeddingCacheFile = JSON.parse(raw);
    return new Map(file.entries.map((e) => [e.chunk_id, { hash: e.hash, embedding: e.embedding }]));
  } catch (err: any) {
    if (err.code === "ENOENT") return new Map();
    throw err;
  }
}

export async function saveEmbeddingCache(
  cachePath: string,
  cache: Map<string, { hash: string; embedding: number[] }>,
): Promise<void> {
  const file: EmbeddingCacheFile = {
    entries: Array.from(cache.entries()).map(([chunk_id, v]) => ({ chunk_id, ...v })),
  };
  await writeFile(cachePath, JSON.stringify(file), "utf-8");
}

// Run directly: tsx src/lib/ingestCorpus.ts
if (import.meta.url === `file://${process.argv[1]}`) {
  const corpusDir = path.resolve(process.cwd(), "finance_rag_corpus");
  const outPath = path.resolve(process.cwd(), "fixtures", "corpus_chunks.json");
  const cachePath = path.resolve(process.cwd(), "fixtures", "corpus_embeddings_cache.json");

  loadCorpusChunks(corpusDir).then(async (chunks) => {
    console.log(`Chunked ${chunks.length} sections from ${corpusDir}. Computing embeddings...`);
    const cache = await loadEmbeddingCache(cachePath);
    const cacheSizeBefore = cache.size;
    const embedded = await embedCorpusChunks(chunks, cache);
    await saveEmbeddingCache(cachePath, cache);
    await writeChunksToFile(embedded, outPath);

    const newlyEmbedded = cache.size - cacheSizeBefore;
    console.log(`Ingested ${embedded.length} chunks -> ${outPath}`);
    console.log(
      `Embeddings: ${embedded.length - newlyEmbedded} from cache, ${newlyEmbedded} newly computed via Bedrock Titan.`,
    );
    const statuses = chunks.reduce<Record<string, number>>((acc, c) => {
      acc[c.status] = (acc[c.status] ?? 0) + 1;
      return acc;
    }, {});
    console.log("Chunk status breakdown:", statuses);
  });
}
