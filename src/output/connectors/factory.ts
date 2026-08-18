import { CalibrationConfig } from "../../types/config.js";
import { TranslatorOutput, SessionSummary } from "../../types/session.js";
import { CareerModeConnector } from "./types.js";
import { getConnectorRegistration, listConnectors } from "./registry.js";
import { LocalFileConnector } from "./local-file.js";

// Side-effect imports: each module calls registerConnector() at load time.
import "./local-file.js";
import "./gist.js";
import "./notion.js";

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

export { listConnectors };

export function createConnector(config: CalibrationConfig): CareerModeConnector {
  const name = config.connector ?? "local";
  const reg = getConnectorRegistration(name);
  const connector = reg.create(config);

  if (reg.alwaysWriteLocal) {
    const local = new LocalFileConnector(config.output_dir);
    return new CompoundConnector([local, connector]);
  }

  return connector;
}
