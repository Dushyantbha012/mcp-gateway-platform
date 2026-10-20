import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { BootstrapFiles } from "./manifests/store.js";

/**
 * The store chart's bootstrap scripts (helm/charts/store/files), so a
 * provisioned store is installed by exactly the same script as the Helm one.
 * The image copies them to gateway/store-files; in the repo they're read
 * from the chart itself.
 */
export function bootstrapDir(): string {
  const gatewayRoot = fileURLToPath(new URL("../../", import.meta.url));
  const candidates = [
    process.env.STORE_BOOTSTRAP_DIR,
    `${gatewayRoot}store-files`,
    `${gatewayRoot}../helm/charts/store/files`,
  ].filter((d): d is string => Boolean(d));
  const found = candidates.find((d) => existsSync(`${d}/bootstrap.sh`));
  if (!found)
    throw new Error(`store bootstrap files not found (looked in ${candidates.join(", ")})`);
  return found;
}

export async function loadBootstrapFiles(dir = bootstrapDir()): Promise<BootstrapFiles> {
  const read = (name: string) => readFile(`${dir}/${name}`, "utf8");
  return {
    "bootstrap.sh": await read("bootstrap.sh"),
    "set-admin.php": await read("set-admin.php"),
    "register-api-key.php": await read("register-api-key.php"),
  };
}
