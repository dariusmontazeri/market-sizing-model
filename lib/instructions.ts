// Loader for per-component instruction files (instructions/*.md). Server-side
// only — called at module load by the component modules, which are imported
// only from API routes.
import fs from "node:fs";
import path from "node:path";

// Reads an instruction file and strips the provenance header comment so the
// prompt delivered to the model stays byte-identical to the pre-move inline
// version (the header is for humans, not the model).
export function loadInstruction(filename: string): string {
  const filePath = path.join(process.cwd(), "instructions", filename);
  const raw = fs.readFileSync(filePath, "utf8");
  return raw
    .replace(/^<!--[\s\S]*?-->\r?\n/, "")
    .replace(/\r\n/g, "\n")
    .trimEnd();
}
