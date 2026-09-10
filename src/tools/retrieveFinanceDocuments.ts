import path from "node:path";
import { readFile } from "node:fs/promises";
import { loadCorpusChunks, type CorpusChunk } from "../lib/ingestCorpus.js";
import { embedText, cosineSimilarity } from "../lib/embeddings.js";
import {
  RetrieveFinanceDocumentsInputSchema,
  RetrieveFinanceDocumentsOutputSchema,
  type RetrieveFinanceDocumentsInput,
  type RetrieveFinanceDocumentsOutput,
} from "../schemas/tools.js";

let cachedChunks: CorpusChunk[] | null = null;

// Prefers the pre-embedded corpus_chunks.json (written by
// `npx tsx src/lib/ingestCorpus.ts`, which computes real Bedrock Titan
// embeddings once and caches them) over re-chunking the raw corpus on the
// fly. Falls back to unembedded chunks only if ingestion hasn't been run
// yet, in which case scoring below degrades to term-overlap for those
// chunks specifically — see scoreRelevance's fallback branch.
async function getChunks(): Promise<CorpusChunk[]> {
  if (cachedChunks) return cachedChunks;

  const embeddedPath = path.resolve(process.cwd(), "fixtures", "corpus_chunks.json");
  try {
    const raw = await readFile(embeddedPath, "utf-8");
    cachedChunks = JSON.parse(raw);
    return cachedChunks!;
  } catch (err: any) {
    if (err.code !== "ENOENT") throw err;
  }

  const corpusDir = path.resolve(process.cwd(), "finance_rag_corpus");
  cachedChunks = await loadCorpusChunks(corpusDir);
  return cachedChunks;
}

// Fallback scoring for chunks with no embedding (corpus ingested without
// running the embedding step) — term-overlap, same as the original
// placeholder. Only used per-chunk, so a partially-embedded corpus still
// gets real cosine-similarity ranking for the chunks that have it.
function termOverlapScore(query: string, text: string): number {
  const queryTerms = new Set(
    query
      .toLowerCase()
      .split(/\W+/)
      .filter((t) => t.length > 2),
  );
  if (queryTerms.size === 0) return 0;
  const textLower = text.toLowerCase();
  let hits = 0;
  for (const term of queryTerms) {
    if (textLower.includes(term)) hits += 1;
  }
  return hits / queryTerms.size;
}

export async function retrieveFinanceDocuments(
  rawInput: unknown,
): Promise<RetrieveFinanceDocumentsOutput> {
  const input: RetrieveFinanceDocumentsInput = RetrieveFinanceDocumentsInputSchema.parse(rawInput);
  const chunks = await getChunks();

  const hasAnyEmbeddings = chunks.some((c) => c.embedding);
  const queryEmbedding = hasAnyEmbeddings ? await embedText(input.query) : null;

  const scored = chunks
    .map((chunk) => {
      const score =
        queryEmbedding && chunk.embedding
          ? cosineSimilarity(queryEmbedding, chunk.embedding)
          : termOverlapScore(input.query, chunk.text);
      return { chunk, score };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, input.top_k);

  const output: RetrieveFinanceDocumentsOutput = {
    chunks: scored.map(({ chunk, score }) => ({
      document_id: chunk.document_id,
      title: chunk.title,
      version: chunk.version,
      status: chunk.status,
      page_or_section: chunk.page_or_section,
      relevance_score: Math.max(0, Math.min(1, score)),
      text: chunk.text,
    })),
  };

  return RetrieveFinanceDocumentsOutputSchema.parse(output);
}

// Test-only: allows tests to reset the module-level chunk cache between
// runs that swap fixtures/corpus_chunks.json out from under it.
export function resetChunkCache(): void {
  cachedChunks = null;
}
