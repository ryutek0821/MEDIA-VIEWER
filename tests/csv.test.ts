import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildDecisionsCsv,
  createCsvDecisionRows,
  createCsvFilename,
  getWritableDirectoryHandle,
  saveDecisionsCsv,
  type CsvDecisionRow,
} from "../lib/csv";
import type { MediaItem } from "../lib/media";

const rows: CsvDecisionRow[] = [
  {
    reviewOrder: 1,
    relativePath: '旅行/海, "朝".jpg',
    fileName: '海, "朝".jpg',
    mediaType: "image",
    decision: "keep",
    sizeBytes: 1234,
    lastModified: Date.UTC(2026, 8, 4, 1, 2, 3),
    decidedAt: "2026-09-04T01:03:00.000Z",
  },
];

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("directory write permission", () => {
  it("reuses the handle when readwrite permission is already granted", async () => {
    const queryPermission = vi.fn(async () => "granted" as PermissionState);
    const requestPermission = vi.fn(async () => "granted" as PermissionState);
    const root = {
      queryPermission,
      requestPermission,
    } as unknown as FileSystemDirectoryHandle;

    await expect(getWritableDirectoryHandle(root)).resolves.toBe(root);
    expect(queryPermission).toHaveBeenCalledWith({ mode: "readwrite" });
    expect(requestPermission).not.toHaveBeenCalled();
  });

  it("requests readwrite permission when it is not already granted", async () => {
    const queryPermission = vi.fn(async () => "prompt" as PermissionState);
    const requestPermission = vi.fn(async () => "granted" as PermissionState);
    const root = {
      queryPermission,
      requestPermission,
    } as unknown as FileSystemDirectoryHandle;

    await expect(getWritableDirectoryHandle(root)).resolves.toBe(root);
    expect(queryPermission).toHaveBeenCalledWith({ mode: "readwrite" });
    expect(requestPermission).toHaveBeenCalledWith({ mode: "readwrite" });
  });

  it("returns null when write permission is denied or permission checks fail", async () => {
    const deniedRoot = {
      queryPermission: vi.fn(async () => "denied" as PermissionState),
      requestPermission: vi.fn(async () => "denied" as PermissionState),
    } as unknown as FileSystemDirectoryHandle;
    const failingRoot = {
      queryPermission: vi.fn(async () => {
        throw new DOMException("blocked", "SecurityError");
      }),
      requestPermission: vi.fn(),
    } as unknown as FileSystemDirectoryHandle;

    await expect(getWritableDirectoryHandle(deniedRoot)).resolves.toBeNull();
    await expect(getWritableDirectoryHandle(failingRoot)).resolves.toBeNull();
  });
});

describe("CSV serialization", () => {
  it("uses a BOM, CRLF, the documented columns, and RFC-style escaping", () => {
    const csv = buildDecisionsCsv(rows);

    expect(csv.startsWith("\uFEFFreview_order,relative_path,file_name,")).toBe(
      true,
    );
    expect(csv).toContain(
      '1,"旅行/海, ""朝"".jpg","海, ""朝"".jpg",image,keep,1234,2026-09-04T01:02:03.000Z,2026-09-04T01:03:00.000Z\r\n',
    );
    expect(csv.replaceAll("\r\n", "")).not.toContain("\n");
  });

  it("neutralizes spreadsheet formulas in user-controlled text cells", () => {
    const csv = buildDecisionsCsv([
      { ...rows[0], relativePath: "=HYPERLINK(\"bad\")", fileName: "+cmd.jpg" },
    ]);

    expect(csv).toContain(`"'=HYPERLINK(""bad"")"`);
    expect(csv).toContain("'+cmd.jpg");
  });

  it("creates rows in review order from media and session decisions", () => {
    const item = {
      id: "photo.jpg",
      relativePath: "album/photo.jpg",
      name: "photo.jpg",
      kind: "image",
      sizeBytes: 42,
      lastModified: 1_725_412_523_000,
      handle: {},
    } as MediaItem;

    expect(
      createCsvDecisionRows([item], {
        "album/photo.jpg": {
          decision: "reject",
          decidedAt: "2026-09-04T01:03:00.000Z",
        },
      }),
    ).toEqual([
      expect.objectContaining({
        reviewOrder: 1,
        relativePath: "album/photo.jpg",
        decision: "reject",
      }),
    ]);
  });

  it("uses a local timestamp and duplicate suffix", () => {
    const date = new Date(2026, 8, 4, 14, 5, 6);
    expect(createCsvFilename(date)).toBe("media-decisions-20260904-140506.csv");
    expect(createCsvFilename(date, 2)).toBe(
      "media-decisions-20260904-140506-2.csv",
    );
  });

  it("writes a new suffixed file without overwriting an existing export", async () => {
    const write = vi.fn(async () => undefined);
    const close = vi.fn(async () => undefined);
    const getFileHandle = vi.fn(
      async (name: string, options?: FileSystemGetFileOptions) => {
        if (!options && name.endsWith(".csv") && !name.endsWith("-2.csv")) {
          return {} as FileSystemFileHandle;
        }
        if (!options) throw new DOMException("missing", "NotFoundError");
        return { createWritable: async () => ({ write, close }) };
      },
    );
    const root = { getFileHandle } as unknown as FileSystemDirectoryHandle;

    const result = await saveDecisionsCsv(
      root,
      rows,
      new Date(2026, 8, 4, 14, 5, 6),
    );

    expect(result).toEqual({
      filename: "media-decisions-20260904-140506-2.csv",
      destination: "folder",
    });
    expect(write).toHaveBeenCalledWith(expect.stringMatching(/^\uFEFF/));
    expect(close).toHaveBeenCalledOnce();
  });

  it("downloads the CSV when no writable directory handle is available", async () => {
    vi.useFakeTimers();
    const createObjectURL = vi.fn(() => "blob:csv");
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", { createObjectURL, revokeObjectURL });
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => undefined);

    const result = await saveDecisionsCsv(
      null,
      rows,
      new Date(2026, 8, 4, 14, 5, 6),
    );
    await vi.runAllTimersAsync();

    expect(result).toEqual({
      filename: "media-decisions-20260904-140506.csv",
      destination: "download",
    });
    expect(createObjectURL).toHaveBeenCalledOnce();
    expect(click).toHaveBeenCalledOnce();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:csv");
  });
});
