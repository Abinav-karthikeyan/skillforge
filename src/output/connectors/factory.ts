import { CalibrationConfig } from "../../types/config.js";
import { TranslatorOutput, SessionSummary } from "../../types/session.js";
import { CareerModeConnector } from "./types.js";
import { LocalFileConnector } from "./local-file.js";
import { GistConnector } from "./gist.js";

/**
 * Chains connectors — writes to each in order, returns the LAST one's result.
 * Used for `connector: gist` so the local index/backup still gets written but
 * the caller sees the shareable Gist URL as the primary return value.
 */
class CompoundConnector implements CareerModeConnector {
  constructor(private readonly connectors: CareerModeConnector[]) {}

  async write(output: TranslatorOutput, session: SessionSummary): Promise<string> {
    let last = "";
    for (const c of this.connectors) {
      last = await c.write(output, session);
    }
    return last;
  }
}

export function createConnector(config: CalibrationConfig): CareerModeConnector {
  const type = config.connector ?? "local";
  const local = new LocalFileConnector(config.output_dir);

  if (type === "local") return local;

  if (type === "gist") {
    const gist = new GistConnector({
      token: config.gist_token,
      isPublic: config.gist_public,
    });
    // Local still writes so index.yml stays authoritative and share_last_artifact keeps working.
    return new CompoundConnector([local, gist]);
  }

  throw new Error(`Unknown connector "${type}". Valid options: local, gist`);
}
