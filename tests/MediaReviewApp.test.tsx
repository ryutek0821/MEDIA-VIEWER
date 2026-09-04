// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import MediaReviewApp from "../app/MediaReviewApp";
import type { MediaItem, ScanMediaResult } from "../lib/media";

const mediaMocks = vi.hoisted(() => ({
  createManifestFingerprint: vi.fn(),
  scanMediaDirectory: vi.fn(),
  sortMediaItems: vi.fn(),
}));

const sessionMocks = vi.hoisted(() => ({
  deleteReviewSession: vi.fn(),
  findMatchingSession: vi.fn(),
  saveReviewSession: vi.fn(),
}));

const csvMocks = vi.hoisted(() => ({
  createCsvDecisionRows: vi.fn(),
  saveDecisionsCsv: vi.fn(),
}));

vi.mock("../lib/media", () => mediaMocks);
vi.mock("../lib/session-store", () => sessionMocks);
vi.mock("../lib/csv", () => csvMocks);

function mediaItem(name: string, relativePath = name): MediaItem {
  return {
    id: relativePath,
    relativePath,
    name,
    kind: "image",
    sizeBytes: 128,
    lastModified: 1_700_000_000_000,
    handle: {
      kind: "file",
      name,
      getFile: vi.fn().mockResolvedValue({ name, size: 128 }),
    } as unknown as FileSystemFileHandle,
  };
}

function scanResult(
  items: MediaItem[],
  errors: ScanMediaResult["errors"] = [],
): ScanMediaResult {
  return {
    items,
    ignoredCount: 0,
    ignoredExtensions: {},
    ignored: {
      hiddenFiles: 0,
      hiddenDirectories: 0,
      skippedDirectories: 0,
      skippedNestedFiles: 0,
      unsupportedFiles: 0,
      unsupportedExtensions: {},
    },
    errors,
  };
}

function folderHandle(name = "写真"): FileSystemDirectoryHandle {
  return { kind: "directory", name } as FileSystemDirectoryHandle;
}

function installFolderPicker(
  implementation: () => Promise<FileSystemDirectoryHandle>,
) {
  const picker = vi.fn(implementation);
  Object.defineProperty(window, "showDirectoryPicker", {
    configurable: true,
    value: picker,
  });
  return picker;
}

async function openFolderWith(items: MediaItem[]) {
  const folder = folderHandle();
  installFolderPicker(async () => folder);
  mediaMocks.scanMediaDirectory.mockResolvedValue(scanResult(items));

  const user = userEvent.setup();
  render(<MediaReviewApp />);
  await user.click(screen.getByRole("button", { name: "フォルダを選ぶ" }));
  await screen.findByText(items[0].name);
  return folder;
}

beforeEach(() => {
  vi.clearAllMocks();
  delete (window as Window & { showDirectoryPicker?: unknown }).showDirectoryPicker;
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    value: vi.fn(() => "blob:preview"),
  });
  Object.defineProperty(URL, "revokeObjectURL", {
    configurable: true,
    value: vi.fn(),
  });

  mediaMocks.createManifestFingerprint.mockResolvedValue("fingerprint");
  mediaMocks.sortMediaItems.mockImplementation((items: MediaItem[]) => items);
  sessionMocks.findMatchingSession.mockResolvedValue(null);
  sessionMocks.saveReviewSession.mockResolvedValue(true);
  sessionMocks.deleteReviewSession.mockResolvedValue(true);
  csvMocks.createCsvDecisionRows.mockReturnValue([{ row: true }]);
  csvMocks.saveDecisionsCsv.mockResolvedValue({
    filename: "media-decisions.csv",
    destination: "folder",
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("MediaReviewApp", () => {
  it("案内メッセージを表示し、未対応ブラウザではフォルダ選択を無効にする", async () => {
    render(<MediaReviewApp />);

    expect(
      await screen.findByText("この機能はChromeまたはEdgeで開いてください。"),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "フォルダを選ぶ" })).toBeDisabled();
  });

  it("フォルダ選択のキャンセル後も開始画面に留まる", async () => {
    const picker = installFolderPicker(async () => {
      throw new DOMException("cancelled", "AbortError");
    });
    const user = userEvent.setup();
    render(<MediaReviewApp />);

    await user.click(screen.getByRole("button", { name: "フォルダを選ぶ" }));

    await waitFor(() => expect(picker).toHaveBeenCalledOnce());
    expect(screen.getByText(/残したい一枚を/)).toBeInTheDocument();
    expect(mediaMocks.scanMediaDirectory).not.toHaveBeenCalled();
    expect(
      screen.queryByText("フォルダを開けませんでした。Chromeのフォルダ権限を確認してください。"),
    ).not.toBeInTheDocument();
  });

  it("走査したメディアをレビュー画面に表示する", async () => {
    const item = mediaItem("photo.jpg");
    const folder = await openFolderWith([item]);

    expect(mediaMocks.scanMediaDirectory).toHaveBeenCalledWith(folder, {
      recursive: false,
    });
    expect(screen.getByText("photo.jpg")).toBeInTheDocument();
    expect(document.querySelector(".progress-copy")).toHaveTextContent("1 / 1");
    expect(screen.getByRole("button", { name: /いる/ })).toBeInTheDocument();
    expect(sessionMocks.saveReviewSession).toHaveBeenCalledOnce();
  });

  it("一部を読み取れない場合はレビュー中と完了後に対象を通知する", async () => {
    const item = mediaItem("photo.jpg");
    const folder = folderHandle();
    const errors: ScanMediaResult["errors"] = [
      { path: "locked/a.jpg", operation: "read-file", message: "denied" },
      { path: "locked/b.jpg", operation: "read-file", message: "denied" },
      { path: "locked/c.jpg", operation: "read-file", message: "denied" },
      { path: "locked/d.jpg", operation: "read-file", message: "denied" },
      { path: "locked/e.jpg", operation: "read-file", message: "denied" },
    ];
    installFolderPicker(async () => folder);
    mediaMocks.scanMediaDirectory.mockResolvedValue(scanResult([item], errors));
    const user = userEvent.setup();
    render(<MediaReviewApp />);

    await user.click(screen.getByRole("button", { name: "フォルダを選ぶ" }));
    await screen.findByText("photo.jpg");

    const reviewNotice = screen.getByRole("alert", { name: "走査エラー" });
    expect(reviewNotice).toHaveTextContent("読み取れなかった項目: 5件");
    expect(reviewNotice).toHaveTextContent("locked/a.jpg、locked/b.jpg、locked/c.jpg、ほか2件");
    expect(reviewNotice).toHaveTextContent("CSVには含まれません");

    fireEvent.keyDown(window, { key: "ArrowRight" });
    await screen.findByText("1件を判定しました");

    const completeNotice = screen.getByRole("alert", { name: "走査エラー" });
    expect(completeNotice).toHaveTextContent("読み取れなかった項目: 5件");
    expect(completeNotice).toHaveTextContent("locked/a.jpg、locked/b.jpg、locked/c.jpg、ほか2件");
  });

  it("サブフォルダ設定がOFFなら直下のメディアだけを走査対象にする", async () => {
    const folder = folderHandle();
    const direct = mediaItem("direct.jpg");
    const nested = mediaItem("nested.jpg", "child/nested.jpg");
    installFolderPicker(async () => folder);
    mediaMocks.scanMediaDirectory.mockImplementation(
      async (_handle: FileSystemDirectoryHandle, options: { recursive?: boolean }) =>
        scanResult(options.recursive ? [direct, nested] : [direct]),
    );
    const user = userEvent.setup();
    render(<MediaReviewApp />);

    expect(screen.getByRole("checkbox", { name: "サブフォルダも含める" })).not.toBeChecked();
    await user.click(screen.getByRole("checkbox", { name: "サブフォルダも含める" }));
    await user.click(screen.getByRole("checkbox", { name: "サブフォルダも含める" }));
    await user.click(screen.getByRole("button", { name: "フォルダを選ぶ" }));
    await screen.findByText("direct.jpg");

    expect(mediaMocks.scanMediaDirectory).toHaveBeenCalledWith(folder, {
      recursive: false,
    });
    expect(mediaMocks.sortMediaItems.mock.calls[0][0]).toEqual([direct]);
    expect(document.querySelector(".progress-copy")).toHaveTextContent("1 / 1");
    expect(screen.getByText("直下のみ")).toBeInTheDocument();
  });

  it("サブフォルダ設定がONなら入れ子のメディアも走査対象にする", async () => {
    const folder = folderHandle();
    const direct = mediaItem("direct.jpg");
    const nested = mediaItem("nested.jpg", "child/nested.jpg");
    installFolderPicker(async () => folder);
    mediaMocks.scanMediaDirectory.mockImplementation(
      async (_handle: FileSystemDirectoryHandle, options: { recursive?: boolean }) =>
        scanResult(options.recursive ? [direct, nested] : [direct]),
    );
    const user = userEvent.setup();
    render(<MediaReviewApp />);

    await user.click(screen.getByRole("checkbox", { name: "サブフォルダも含める" }));
    await user.click(screen.getByRole("button", { name: "フォルダを選ぶ" }));
    await screen.findByText("direct.jpg");

    expect(mediaMocks.scanMediaDirectory).toHaveBeenCalledWith(folder, {
      recursive: true,
    });
    expect(mediaMocks.sortMediaItems.mock.calls[0][0]).toEqual([direct, nested]);
    expect(document.querySelector(".progress-copy")).toHaveTextContent("1 / 2");
  });

  it("右キーをいる、左キーをいらないとして記録する", async () => {
    const first = mediaItem("first.jpg");
    const second = mediaItem("second.jpg");
    const third = mediaItem("third.jpg");
    await openFolderWith([first, second, third]);

    fireEvent.keyDown(window, { key: "ArrowRight" });
    await screen.findByText("second.jpg");
    await waitFor(() => {
      const saved = sessionMocks.saveReviewSession.mock.calls.at(-1)?.[0];
      expect(saved.decisions["first.jpg"].decision).toBe("keep");
    });

    fireEvent.keyDown(window, { key: "ArrowLeft" });
    await screen.findByText("third.jpg");
    await waitFor(() => {
      const saved = sessionMocks.saveReviewSession.mock.calls.at(-1)?.[0];
      expect(saved.decisions["second.jpg"].decision).toBe("reject");
    });
  });

  it("最後の判定後にCSVを保存して完了画面を表示する", async () => {
    const item = mediaItem("only.jpg");
    const folder = await openFolderWith([item]);

    fireEvent.keyDown(window, { key: "ArrowRight" });

    await waitFor(() => expect(csvMocks.createCsvDecisionRows).toHaveBeenCalledOnce());
    expect(csvMocks.saveDecisionsCsv).toHaveBeenCalledWith(folder, [{ row: true }]);
    expect(await screen.findByText("1件を判定しました")).toBeInTheDocument();
    expect(screen.getByText("media-decisions.csv")).toBeInTheDocument();
  });
});
