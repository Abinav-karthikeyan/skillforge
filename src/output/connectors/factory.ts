import { CalibrationConfig } from "../../types/config.js";
import { TranslatorOutput, SessionSummary } from "../../types/session.js";
import { CareerModeConnector } from "./types.js";
import { getConnectorRegistration, listConnectors, registerConnector } from "./registry.js";
import { LocalFileConnector } from "./local-file.js";

// Side-effect imports: each module calls registerConnector() at load time.
import "./local-file.js";
import "./gist.js";
import "./notion.js";

// Host-delivery mode (plan_ahead.md Bet 2). Not a new connector class — it reuses
// LocalFileConnector so the artifact still lands in the local corpus/index. The
// "return the rendered artifact to the caller so the host delivers it" behavior
// lives in the tool layer (MCP + CLI), keyed off config.connector === "return_only",
// because the CareerModeConnector contract returns a location string, not content.
registerConnector({
  name: "return_only",
  secretFields: [],
  alwaysWriteLocal: false,
  create(config) {
    return new LocalFileConnector(config.output_dir);
  },
});

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
