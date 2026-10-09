import { eq } from "drizzle-orm";
import { defaultModels, type ModelId } from "./models";
import type { SetupState } from "../runpod/runpod_provisioner";
import { db } from "../db/db.server";
import { runpodSetup } from "../db/schema";

// Include models selected during setup so jobs can queue before readiness.
// Without a pod, queue against the default setup selection.
export function generationModels(): readonly ModelId[] {
  const row = db.select().from(runpodSetup).where(eq(runpodSetup.id, 1)).get();
  const setup = row ? (JSON.parse(row.state) as SetupState) : null;
  return setup ? setup.models : defaultModels;
}
