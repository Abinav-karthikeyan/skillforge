import { CalibrationConfig } from "../../types/config.js";
import { CareerModeConnector } from "./types.js";

export interface ConnectorRegistration {
  name: string;
  secretFields: string[];
  alwaysWriteLocal: boolean;
  create(config: CalibrationConfig): CareerModeConnector;
}

const connectors = new Map<string, ConnectorRegistration>();

export function registerConnector(reg: ConnectorRegistration): void {
  connectors.set(reg.name, reg);
}

export function getConnectorRegistration(name: string): ConnectorRegistration {
  const reg = connectors.get(name);
  if (!reg) {
    throw new Error(
      `Unknown connector "${name}". Valid options: ${listConnectors().join(", ")}`
    );
  }
  return reg;
}

export function listConnectors(): string[] {
  return Array.from(connectors.keys());
}

export function allSecretFields(): string[] {
  const fields = new Set<string>();
  for (const reg of connectors.values()) {
    for (const f of reg.secretFields) fields.add(f);
  }
  return Array.from(fields);
}
