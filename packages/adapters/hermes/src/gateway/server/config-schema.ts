import type { AdapterConfigSchema } from "@paperclipai/adapter-utils";
import {
  getHermesGatewayConfigSchema,
  type AdapterCatalogContext,
} from "./model-options.js";

export { getHermesGatewayConfigSchema };

export function getConfigSchema(
  ctx?: AdapterCatalogContext,
): Promise<AdapterConfigSchema> {
  return getHermesGatewayConfigSchema(ctx);
}
