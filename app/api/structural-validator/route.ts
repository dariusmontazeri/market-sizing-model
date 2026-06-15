import { validateStructure } from "../../../lib/structuralValidator";
import { isProposedStructure } from "../../../lib/structureProposer";

// Structural validator route — the pre-research shape gate. It is NOT wired live
// to the proposer (that, plus the proposer's intermittent empty-turn issue, is a
// later slice). The contract is the eventual one: POST the proposer's output
// ({ market, structure }) and get the gate verdict back. The checkpoint test
// (scripts/test-structural-validator.ts) drives the component against a saved
// Germany fixture directly; this route is for manual probing of that contract.
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

  // Guard the shape here, at the boundary: the validator's job is to judge a
  // well-formed structure's soundness, not to absorb malformed input.
  if (!marketOk || !isProposedStructure(structure)) {
    return Response.json(
      {
        ok: false,
        error:
          "Body must be { market: { country, market }, structure: <proposed structure> }.",
      },
      { status: 400 },
    );
  }

  try {
    const result = await validateStructure({
      market: market as { country: string; market: string },
      structure,
    });
    return Response.json(result);
  } catch (err) {
    // Fail safely: real error to server logs, clean message to the client.
    // Never echo error internals — they can contain key fragments or headers.
    console.error("[/api/structural-validator]", err);
    return Response.json(
      { ok: false, error: "Structural validator call failed. Check server logs." },
      { status: 500 },
    );
  }
}
