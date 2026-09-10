import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

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

// Run directly: tsx src/lib/ingestCorpus.ts
if (import.meta.url === `file://${process.argv[1]}`) {
  const corpusDir = path.resolve(process.cwd(), "finance_rag_corpus");
  const outPath = path.resolve(process.cwd(), "fixtures", "corpus_chunks.json");
  loadCorpusChunks(corpusDir).then(async (chunks) => {
    await writeChunksToFile(chunks, outPath);
    console.log(`Ingested ${chunks.length} chunks from ${corpusDir} -> ${outPath}`);
    const statuses = chunks.reduce<Record<string, number>>((acc, c) => {
      acc[c.status] = (acc[c.status] ?? 0) + 1;
      return acc;
    }, {});
    console.log("Chunk status breakdown:", statuses);
  });
}
