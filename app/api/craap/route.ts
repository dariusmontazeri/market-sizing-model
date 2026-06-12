import { isAnchorSkeleton } from "../../../lib/researcher";
import {
  validateSkeleton,
  type SlotDefinition,
} from "../../../lib/craapValidator";

function isSlotDefinition(value: unknown): value is SlotDefinition {
  return (
    typeof value === "object" &&
    value !== null &&
    "geography" in value &&
    typeof value.geography === "string" &&
    "metric" in value &&
    typeof value.metric === "string" &&
    "definition" in value &&
    typeof value.definition === "string"
  );
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json(
      { ok: false, error: "Body must be JSON: { slot, skeleton }" },
      { status: 400 },
    );
  }

  if (
    typeof body !== "object" ||
    body === null ||
    !("slot" in body) ||
    !("skeleton" in body) ||
    !isSlotDefinition(body.slot) ||
    !isAnchorSkeleton(body.skeleton)
  ) {
    return Response.json(
      { ok: false, error: "Body must contain a valid slot and skeleton" },
      { status: 400 },
    );
  }

  try {
    const result = await validateSkeleton(body.slot, body.skeleton);
    return Response.json(result);
  } catch (err) {
    // Fail safely: real error to server logs, clean message to the client.
    console.error("[/api/craap]", err);
    return Response.json(
      { ok: false, error: "CRAAP validation failed. Check server logs." },
      { status: 500 },
    );
  }
}
