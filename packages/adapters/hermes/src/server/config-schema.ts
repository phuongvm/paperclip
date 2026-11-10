import type { AdapterConfigSchema } from "@paperclipai/adapter-utils";
import { getDynamicConfigSchema } from "./catalog.js";

export async function getConfigSchema(): Promise<AdapterConfigSchema> {
  return getDynamicConfigSchema();
}
