import path from "node:path";
import { loadCorpusChunks, type CorpusChunk } from "../lib/ingestCorpus.js";
import {
  RetrieveFinanceDocumentsInputSchema,
  RetrieveFinanceDocumentsOutputSchema,
  type RetrieveFinanceDocumentsInput,
  type RetrieveFinanceDocumentsOutput,
} from "../schemas/tools.js";

let cachedChunks: CorpusChunk[] | null = null;

async function getChunks(): Promise<CorpusChunk[]> {
  if (!cachedChunks) {
    const corpusDir = path.resolve(process.cwd(), "finance_rag_corpus");
    cachedChunks = await loadCorpusChunks(corpusDir);
  }
  return cachedChunks;
}

// Placeholder relevance: normalized term-overlap score. Swapped for real
// embedding cosine similarity in A5, once a live Bedrock embeddings call is
// wired up — this keeps retrieval fully local and free for Stage A dev.
function scoreRelevance(query: string, text: string): number {
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

  const scored = chunks
    .map((chunk) => ({ chunk, score: scoreRelevance(input.query, chunk.text) }))
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
      relevance_score: Math.min(1, score),
      text: chunk.text,
    })),
  };

  return RetrieveFinanceDocumentsOutputSchema.parse(output);
}
