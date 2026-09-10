import { describe, it, expect } from "vitest";
import path from "node:path";
import { loadCorpusChunks } from "../src/lib/ingestCorpus.js";

const corpusDir = path.resolve(process.cwd(), "finance_rag_corpus");

describe("loadCorpusChunks", () => {
  it("ingests all 15 corpus documents into chunks", async () => {
    const chunks = await loadCorpusChunks(corpusDir);
    const uniqueDocs = new Set(chunks.map((c) => c.document_id));
    expect(uniqueDocs.size).toBe(15);
  });

  it("preserves document_id, version, and status for every chunk", async () => {
    const chunks = await loadCorpusChunks(corpusDir);
    for (const chunk of chunks) {
      expect(chunk.document_id).toBeTruthy();
      expect(chunk.version).toBeTruthy();
      expect(["current", "superseded", "untrusted"]).toContain(chunk.status);
    }
  });

  it("includes the adversarial document flagged as untrusted, not filtered out", async () => {
    const chunks = await loadCorpusChunks(corpusDir);
    const adversarial = chunks.filter((c) => c.document_id === "ADV-001");
    expect(adversarial.length).toBeGreaterThan(0);
    expect(adversarial[0].status).toBe("untrusted");
    expect(adversarial[0].text).toMatch(/ignore all previous policies/i);
  });

  it("includes the irrelevant travel document flagged as untrusted, not filtered out", async () => {
    const chunks = await loadCorpusChunks(corpusDir);
    const irrelevant = chunks.filter((c) => c.document_id === "ADV-002");
    expect(irrelevant.length).toBeGreaterThan(0);
    expect(irrelevant[0].status).toBe("untrusted");
  });

  it("includes the superseded authority matrix flagged as superseded, not silently dropped", async () => {
    const chunks = await loadCorpusChunks(corpusDir);
    const superseded = chunks.filter((c) => c.document_id === "FIN-POL-003-OLD");
    expect(superseded.length).toBeGreaterThan(0);
    expect(superseded[0].status).toBe("superseded");
  });

  it("the current authority matrix (FIN-POL-003) is separate from the superseded one and marked current", async () => {
    const chunks = await loadCorpusChunks(corpusDir);
    const current = chunks.filter((c) => c.document_id === "FIN-POL-003");
    expect(current.length).toBeGreaterThan(0);
    expect(current[0].status).toBe("current");
    expect(current[0].version).toBe("4.0");
  });
});
