import { analyzeUntrusted, researchAnchorSlot } from "../../../lib/researcher";

// Hard cap on untrusted input size — keeps a hostile or accidental megapaste
// from burning tokens. Real rate limiting comes before the public link.
const MAX_INPUT_CHARS = 4000;

export async function POST(request: Request) {
  // Body with {input: string} → injection-boundary analysis (Checkpoint 2).
  // No/empty body → anchor-slot research (Checkpoint 3 behavior).
  let input: string | null = null;
  try {
    const body: unknown = await request.json();
    if (
      typeof body === "object" &&
      body !== null &&
      "input" in body &&
      typeof body.input === "string"
    ) {
      input = body.input.slice(0, MAX_INPUT_CHARS);
    }
  } catch {
    // No/invalid JSON body — fall through to anchor research.
  }

  try {
    const result =
      input !== null ? await analyzeUntrusted(input) : await researchAnchorSlot();
    return Response.json(result);
  } catch (err) {
    // Fail safely: log the real error server-side, return a clean message to
    // the client. Never echo error internals — they can contain key fragments
    // or request headers.
    console.error("[/api/researcher]", err);
    return Response.json(
      { ok: false, error: "Researcher call failed. Check server logs." },
      { status: 500 },
    );
  }
}
