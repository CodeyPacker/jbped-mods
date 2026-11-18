// Herdr's "fs/promises" for mod code: node's, plus exists() (Herdr has it, node doesn't).
import { access } from "node:fs/promises";
export * from "node:fs/promises";
export const exists = (p) => access(p).then(() => true, () => false);
