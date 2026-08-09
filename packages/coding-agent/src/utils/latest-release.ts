/**
 * Newest published release lookup.
 *
 * oms ships as a GitHub release binary and is not published to any package
 * registry, so the startup update notice and `oms update` both resolve the
 * newest version from the repository's releases.
 *
 * This reads the `releases/latest` redirect rather than the REST API: GitHub
 * answers it with a 302 to the tag page, it needs no token, and it is not
 * subject to the API's 60-requests-per-hour unauthenticated limit — which a
 * shared egress IP (CI, containers, an office NAT) burns through quickly, and
 * which would otherwise make the startup check fail exactly where it is
 * hardest to debug.
 */
import { withTimeoutSignal } from "./fetch-timeout";

/** `owner/repo` the release binaries are published from. */
export const RELEASE_REPO = "pickpocket/oh-my-soup";

export interface LatestRelease {
	/** Release tag, e.g. `v17.2.13`. */
	tag: string;
	/** Tag without its leading `v`, e.g. `17.2.13`. */
	version: string;
}

/**
 * Resolve the newest published release.
 *
 * @throws when the repository has no releases, or GitHub is unreachable /
 *   times out.
 */
export async function fetchLatestRelease(timeoutMs: number): Promise<LatestRelease> {
	const response = await fetch(`https://github.com/${RELEASE_REPO}/releases/latest`, {
		redirect: "manual",
		signal: withTimeoutSignal(timeoutMs),
	});
	// The 302 points at `…/releases/tag/<tag>`. A repository with no releases
	// redirects to the releases index instead, which carries no tag. `response.url`
	// is the fallback for a runtime that followed the redirect anyway.
	const target = response.headers.get("location") || response.url || "";
	const tag = /\/releases\/tag\/([^/?#]+)$/.exec(target)?.[1];
	if (!tag) {
		throw new Error(`No published release found for ${RELEASE_REPO}`);
	}
	const decoded = decodeURIComponent(tag);
	return { tag: decoded, version: decoded.replace(/^v/, "") };
}
