import { proposeStructure } from "../../../lib/structureProposer";

// Structure proposer route — Phase 1 of the units-based method. The market is
// hardcoded in the component for now (Germany prosthetics), so this route takes
// no input; POST runs the proposer and returns the proposed shape.
export async function POST() {
  try {
    const result = await proposeStructure();
    return Response.json(result);
  } catch (err) {
    // Fail safely: real error to server logs, clean message to the client.
    // Never echo error internals — they can contain key fragments or headers.
    console.error("[/api/structure-proposer]", err);
    return Response.json(
      { ok: false, error: "Structure proposer call failed. Check server logs." },
      { status: 500 },
    );
  }
}
