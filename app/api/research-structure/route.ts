import { researchValidatedStructure } from "../../../lib/researcher";
import { isProposedStructure } from "../../../lib/structureProposer";

// Phase 1 -> Phase 2 connection route. NOT wired live to the proposer or the
// structural validator (that orchestration is a later slice). The contract is
// the eventual one: POST a validated structure ({ market, structure }) and get
// each slot resolved to a sourced figure. The checkpoint test
// (scripts/test-research-structure.ts) drives the component against a saved
// validated Germany structure directly.
export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json(
      { ok: false, error: "Request body must be JSON: { market, structure }." },
      { status: 400 },
    );
  }

  const market = (body as Record<string, unknown>)?.market;
  const structure = (body as Record<string, unknown>)?.structure;
  const marketOk =
    typeof market === "object" &&
    market !== null &&
    typeof (market as Record<string, unknown>).country === "string" &&
    typeof (market as Record<string, unknown>).market === "string";

  // Guard the shape at the boundary: the researcher resolves the slots of a
  // well-formed validated structure, not malformed input.
  if (!marketOk || !isProposedStructure(structure)) {
    return Response.json(
      {
        ok: false,
        error:
          "Body must be { market: { country, market }, structure: <validated structure> }.",
      },
      { status: 400 },
    );
  }

  try {
    const result = await researchValidatedStructure({
      market: market as { country: string; market: string },
      structure,
    });
    return Response.json(result);
  } catch (err) {
    // Fail safely: real error to server logs, clean message to the client.
    console.error("[/api/research-structure]", err);
    return Response.json(
      { ok: false, error: "Structure research failed. Check server logs." },
      { status: 500 },
    );
  }
}
