import { describe, expect, it } from "vitest";
import {
  getContentType,
  getExtension,
  getMediaKind,
  isQueueMode,
  isRating,
  isSha256,
} from "../lib/media.ts";

describe("media helpers", () => {
  it("classifies supported extensions case-insensitively", () => {
    expect(getExtension("MARIN_00001_.PNG")).toBe("png");
    expect(getMediaKind("MARIN_00001_.PNG")).toBe("image");
    expect(getMediaKind("clip.mp4")).toBe("video");
    expect(getMediaKind("workflow.json")).toBeNull();
    expect(getMediaKind(".png")).toBeNull();
    expect(getMediaKind("trap.constructor")).toBeNull();
  });

  it("maps content types", () => {
    expect(getContentType("a.jpg")).toBe("image/jpeg");
    expect(getContentType("a.webm")).toBe("video/webm");
    expect(getContentType("a.txt")).toBeNull();
  });

  it("validates ratings, queue modes and hashes", () => {
    expect(isRating("hold")).toBe(true);
    expect(isRating("maybe")).toBe(false);
    expect(isQueueMode("unrated")).toBe(true);
    expect(isQueueMode("rated")).toBe(false);
    expect(isSha256("a".repeat(64))).toBe(true);
    expect(isSha256("A".repeat(64))).toBe(false);
  });
});
