const FALLBACK = "/accept-invite/set-password";

// Restricts a redirect target to a same-site relative path. Using the URL
// parser (rather than string prefix checks like startsWith("/")) matters:
// browsers normalize backslashes to slashes when resolving protocol-relative
// URLs for special schemes, so "/\evil.com" is NOT caught by
// startsWith("//") but IS treated as "//evil.com" (a different origin) once
// actually parsed — using URL here applies the same normalization the
// browser will, instead of a hand-rolled check that can miss it.
export function safeRedirectPath(candidate: string | null): string {
  if (!candidate) return FALLBACK;

  let resolved: URL;
  try {
    resolved = new URL(candidate, "http://localhost");
  } catch {
    return FALLBACK;
  }

  if (resolved.origin !== "http://localhost") return FALLBACK;

  // Rebuild from parsed parts only — never pass the original string or
  // resolved.href through, so nothing the parser didn't put in pathname/
  // search/hash can smuggle an authority back in.
  const rebuilt = resolved.pathname + resolved.search + resolved.hash;

  // The origin check above isn't sufficient on its own: a dot-segment
  // combined with a backslash (e.g. "/../\evil.com") normalizes to a
  // pathname of "//evil.com" while resolved.origin still reports
  // "http://localhost" — the origin check passes, but the REBUILT string
  // is itself protocol-relative and unsafe to hand to a browser as a bare
  // redirect target. Reject the output, not just the intermediate parse.
  if (rebuilt.startsWith("//") || rebuilt.startsWith("/\\")) return FALLBACK;

  return rebuilt;
}
