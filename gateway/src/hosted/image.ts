/**
 * Container image references and the registry allowlist for hosted servers.
 * A hosted image is untrusted code running inside the cluster, so admins may
 * only pick from registries/repositories the operator allowlisted (Helm:
 * hosted.imageAllowlist), and only by a pinned tag or digest.
 */

// [registry/]repo[/more]:tag or @sha256:..., lowercase repository path.
const REFERENCE =
  /^(?<name>(?:[a-z0-9.-]+(?::[0-9]+)?\/)?[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*)(?::(?<tag>[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}))?(?:@(?<digest>sha256:[a-f0-9]{64}))?$/;

export class ImageNotAllowedError extends Error {}

/**
 * The fully qualified repository name: "mcp/time" -> "docker.io/mcp/time",
 * "redis" -> "docker.io/library/redis", "ghcr.io/x/y" stays. This is how
 * containerd resolves short names, so the allowlist can't be dodged by
 * spelling one image two ways.
 */
export function qualifyRepository(name: string): string {
  const parts = name.split("/");
  const first = parts[0]!;
  const hasRegistry =
    parts.length > 1 && (first.includes(".") || first.includes(":") || first === "localhost");
  if (hasRegistry) return name;
  return parts.length === 1 ? `docker.io/library/${name}` : `docker.io/${name}`;
}

export interface ParsedImage {
  repository: string;
  tag?: string;
  digest?: string;
}

export function parseImage(image: string): ParsedImage {
  const m = REFERENCE.exec(image);
  if (!m?.groups) throw new ImageNotAllowedError(`'${image}' is not a valid image reference`);
  const { name, tag, digest } = m.groups;
  return { repository: qualifyRepository(name!), tag, digest };
}

/**
 * Entries are repository prefixes: "docker.io/mcp/" allows every image under
 * mcp/, "ghcr.io/acme/server" allows exactly that repository (not
 * "ghcr.io/acme/server-evil"). Short names are qualified like images are.
 */
function allows(entry: string, repository: string): boolean {
  if (entry.endsWith("/")) {
    // A namespace, not an image: "mcp/" is docker.io/mcp/, not docker.io/library/mcp/.
    const prefix = qualifyRepository(`${entry}x`).slice(0, -1);
    return repository.startsWith(prefix);
  }
  return repository === qualifyRepository(entry);
}

/** Throws ImageNotAllowedError with a message fit for the admin. */
export function checkImage(image: string, allowlist: string[]): ParsedImage {
  const parsed = parseImage(image);
  if (!parsed.tag && !parsed.digest) {
    throw new ImageNotAllowedError("pin the image to a tag or digest (e.g. mcp/time:1.2.0)");
  }
  if (parsed.tag === "latest" && !parsed.digest) {
    throw new ImageNotAllowedError(
      "':latest' isn't allowed: pin a version, so a restart can't silently change the code",
    );
  }
  if (!allowlist.some((entry) => allows(entry, parsed.repository))) {
    throw new ImageNotAllowedError(
      allowlist.length
        ? `${parsed.repository} is not in the image allowlist (${allowlist.join(", ")})`
        : "no images are allowlisted for hosted servers on this gateway",
    );
  }
  return parsed;
}
