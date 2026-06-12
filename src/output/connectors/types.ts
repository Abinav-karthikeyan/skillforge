import { TranslatorOutput } from "../../types/session.js";
import { SessionSummary } from "../../types/session.js";

export interface CareerModeConnector {
  write(output: TranslatorOutput, session: SessionSummary): Promise<string>;
}
