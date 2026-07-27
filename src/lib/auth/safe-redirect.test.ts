import { describe, expect, it } from "vitest";
import { safeRedirectPath } from "./safe-redirect";

describe("safeRedirectPath", () => {
  it("allows a plain same-site relative path", () => {
    expect(safeRedirectPath("/accept-invite/set-password")).toBe(
      "/accept-invite/set-password",
    );
  });

  it("allows a relative path with query and hash", () => {
    expect(safeRedirectPath("/select-club?foo=bar#section")).toBe(
      "/select-club?foo=bar#section",
    );
  });

  it("falls back to the default when null", () => {
    expect(safeRedirectPath(null)).toBe("/accept-invite/set-password");
  });

  it("falls back to the default for an empty string", () => {
    expect(safeRedirectPath("")).toBe("/accept-invite/set-password");
  });

  it("rejects an absolute URL to another origin", () => {
    expect(safeRedirectPath("https://evil.com")).toBe("/accept-invite/set-password");
  });

  it("rejects a protocol-relative URL", () => {
    expect(safeRedirectPath("//evil.com")).toBe("/accept-invite/set-password");
  });

  it("rejects the backslash-normalization bypass", () => {
    expect(safeRedirectPath("/\\evil.com")).toBe("/accept-invite/set-password");
    expect(safeRedirectPath("/\\/evil.com")).toBe("/accept-invite/set-password");
  });

  it("treats a schemeless bare word as a same-site relative path, not a host", () => {
    // No leading slash means the URL parser resolves it as a path segment
    // on the current origin (e.g. "evil.com" -> "/evil.com"), not a host —
    // genuinely safe, not a bypass.
    expect(safeRedirectPath("evil.com")).toBe("/evil.com");
  });

  it("rejects an unparseable string", () => {
    expect(safeRedirectPath("http://user:pass@[invalid")).toBe(
      "/accept-invite/set-password",
    );
  });
});
