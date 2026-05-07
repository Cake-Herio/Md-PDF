import { createHash } from "node:crypto";

export function sha256(content: Buffer) {
  return createHash("sha256").update(content).digest("hex");
}
