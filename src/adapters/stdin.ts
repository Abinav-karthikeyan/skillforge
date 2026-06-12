import { readFileSync } from "fs";

export function readFromStdin(): string {
  return readFileSync("/dev/stdin", "utf-8");
}

export function readFromFile(path: string): string {
  return readFileSync(path, "utf-8");
}
