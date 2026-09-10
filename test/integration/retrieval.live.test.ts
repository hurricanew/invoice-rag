// Model-dependent integration tests — these make REAL Bedrock Titan
// Embeddings calls and incur real (small) cost. Kept separate from the
// stable unit suite per the spec's requirement to distinguish
// deterministic tests from model-dependent ones. Run explicitly with:
// npm run test:integration (not part of the default `npm test` run).
//
// Moved here from test/tools.test.ts once retrieveFinanceDocuments
// switched from local term-overlap scoring to real embedding-based
// cosine similarity — these specifically test retrieval QUALITY (does a
// semantically relevant query surface the right document), which can
// only be verified against the real embedding model, not a mock.
import { describe, it, expect } from "vitest";
import { retrieveFinanceDocuments } from "../../src/tools/retrieveFinanceDocuments.js";

describe("retrieveFinanceDocuments — live embedding retrieval quality", () => {
  it("returns ranked chunks with citation metadata for a relevant query", async () => {
    const result = await retrieveFinanceDocuments({
      query: "three-way match tolerance goods variance",
      top_k: 5,
    });
    expect(result.chunks.length).toBeGreaterThan(0);
    expect(result.chunks[0]).toHaveProperty("document_id");
    expect(result.chunks[0]).toHaveProperty("version");
    expect(result.chunks[0]).toHaveProperty("status");
    // The top hit should genuinely be about matching/tolerances, not an
    // unrelated policy — this is what real cosine similarity buys over
    // the old term-overlap placeholder.
    expect(result.chunks[0].document_id).toBe("FIN-POL-002");
  });

  it("retrieves the adversarial document when the query matches bank-change/urgency language", async () => {
    const result = await retrieveFinanceDocuments({
      query: "urgent bank account change payment release",
      top_k: 10,
    });
    const adversarial = result.chunks.find((c) => c.document_id === "ADV-001");
    expect(adversarial).toBeDefined();
    expect(adversarial!.status).toBe("untrusted");
  });

  it("surfaces the right policy for a paraphrased query with no literal keyword overlap", async () => {
    // No shared vocabulary with FIN-POL-004's actual text ("bank account",
    // "verification") — a term-overlap scorer would find this near zero
    // across the board. Real embeddings should still rank it highly,
    // since this is exactly the semantic-similarity gap embeddings close.
    const result = await retrieveFinanceDocuments({
      query: "supplier payment moved to a different account without telling us first",
      top_k: 5,
    });
    const bankChangePolicy = result.chunks.find((c) => c.document_id === "FIN-POL-004");
    expect(bankChangePolicy).toBeDefined();
  });
});
