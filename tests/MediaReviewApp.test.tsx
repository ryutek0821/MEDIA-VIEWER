// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import MediaReviewApp from "../app/MediaReviewApp.tsx";
import type { QueueItem, RatingStats } from "../lib/media.ts";

const api = vi.hoisted(() => ({
  fetchQueue: vi.fn(),
  putRating: vi.fn(),
  deleteRating: vi.fn(),
  mediaUrl: (sha256: string) => `/media/${sha256}`,
}));

vi.mock("../app/api.ts", () => api);

function item(name: string, rating: QueueItem["rating"] = null): QueueItem {
  return {
    sha256: `sha-${name}`,
    relPath: `batch/${name}.png`,
    kind: "image",
    sizeBytes: 2048,
    mtimeMs: 1_757_550_000_000,
    rating,
    ratedAt: null,
  };
}

const STATS: RatingStats = { total: 2, unrated: 2, reject: 0, keep: 0, hold: 0 };

function queueResponse(items: QueueItem[], stats: RatingStats = STATS) {
  return { mode: "unrated", items, stats, scanError: null };
}

describe("MediaReviewApp", () => {
  beforeEach(() => {
    api.fetchQueue.mockReset().mockResolvedValue(queueResponse([item("a"), item("b")]));
    api.putRating.mockReset().mockResolvedValue(undefined);
    api.deleteRating.mockReset().mockResolvedValue(undefined);
  });

  it("rates with the arrow keys and advances to the next item", async () => {
    const user = userEvent.setup();
    render(<MediaReviewApp />);

    expect(await screen.findByRole("img", { name: "batch/a.png" })).toBeInTheDocument();
    await user.keyboard("{ArrowLeft}");
    expect(await screen.findByRole("img", { name: "batch/b.png" })).toBeInTheDocument();
    await user.keyboard("{ArrowDown}");

    expect(await screen.findByRole("heading", { name: "評価待ちはありません" })).toBeInTheDocument();
    await waitFor(() => expect(api.putRating).toHaveBeenCalledTimes(2));
    expect(api.putRating).toHaveBeenNthCalledWith(1, "sha-a", "reject");
    expect(api.putRating).toHaveBeenNthCalledWith(2, "sha-b", "hold");
    expect(screen.getByText("◯ 0")).toBeInTheDocument();
    expect(screen.getByText("✕ 1")).toBeInTheDocument();
    expect(screen.getByText("△ 1")).toBeInTheDocument();
  });

  it("rates with the on-screen buttons", async () => {
    const user = userEvent.setup();
    render(<MediaReviewApp />);

    await screen.findByRole("img", { name: "batch/a.png" });
    await user.click(screen.getByRole("button", { name: "マル" }));
    await screen.findByRole("img", { name: "batch/b.png" });
    await user.click(screen.getByRole("button", { name: "保留" }));

    await waitFor(() => expect(api.putRating).toHaveBeenCalledWith("sha-b", "hold"));
    expect(api.putRating).toHaveBeenCalledWith("sha-a", "keep");
  });

  it("marks an upward swipe as hold", async () => {
    render(<MediaReviewApp />);

    const card = (await screen.findByRole("img", { name: "batch/a.png" })).parentElement;
    if (!card) throw new Error("media card missing");
    fireEvent.pointerDown(card, { pointerId: 1, clientX: 100, clientY: 300 });
    fireEvent.pointerMove(card, { pointerId: 1, clientX: 104, clientY: 180 });
    fireEvent.pointerUp(card, { pointerId: 1, clientX: 104, clientY: 180 });

    await waitFor(() => expect(api.putRating).toHaveBeenCalledWith("sha-a", "hold"));
  });

  it("ignores a tap without movement", async () => {
    render(<MediaReviewApp />);

    const card = (await screen.findByRole("img", { name: "batch/a.png" })).parentElement;
    if (!card) throw new Error("media card missing");
    fireEvent.pointerDown(card, { pointerId: 1, clientX: 100, clientY: 300 });
    fireEvent.pointerUp(card, { pointerId: 1, clientX: 100, clientY: 300 });

    expect(screen.getByRole("img", { name: "batch/a.png" })).toBeInTheDocument();
    expect(api.putRating).not.toHaveBeenCalled();
  });

  it("undoes the last rating and restores the previous value", async () => {
    api.fetchQueue.mockResolvedValue(queueResponse([item("a", "hold"), item("b")]));
    const user = userEvent.setup();
    render(<MediaReviewApp />);

    await screen.findByRole("img", { name: "batch/a.png" });
    await user.keyboard("{ArrowRight}");
    await screen.findByRole("img", { name: "batch/b.png" });
    await user.keyboard("{ArrowRight}");
    await user.keyboard("{Backspace}");
    expect(await screen.findByRole("img", { name: "batch/b.png" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "取り消し" }));
    expect(await screen.findByRole("img", { name: "batch/a.png" })).toBeInTheDocument();

    await waitFor(() => expect(api.putRating).toHaveBeenCalledTimes(3));
    expect(api.deleteRating).toHaveBeenCalledWith("sha-b");
    expect(api.putRating).toHaveBeenLastCalledWith("sha-a", "hold");
  });

  it("reloads the queue and explains when a rating cannot be saved", async () => {
    api.putRating.mockRejectedValueOnce(new Error("offline"));
    const user = userEvent.setup();
    render(<MediaReviewApp />);

    await screen.findByRole("img", { name: "batch/a.png" });
    await user.keyboard("{ArrowRight}");

    expect(await screen.findByText(/評価を保存できませんでした（offline）/)).toBeInTheDocument();
    await waitFor(() => expect(api.fetchQueue).toHaveBeenCalledTimes(2));
    expect(await screen.findByRole("img", { name: "batch/a.png" })).toBeInTheDocument();
  });

  it("loads the hold queue when the mode changes", async () => {
    const user = userEvent.setup();
    render(<MediaReviewApp />);

    await screen.findByRole("img", { name: "batch/a.png" });
    api.fetchQueue.mockResolvedValue(queueResponse([]));
    await user.selectOptions(screen.getByRole("combobox", { name: "表示する対象" }), "hold");

    expect(await screen.findByRole("heading", { name: "保留はありません" })).toBeInTheDocument();
    expect(api.fetchQueue).toHaveBeenLastCalledWith("hold");
  });

  it("offers a retry when the queue cannot be loaded", async () => {
    api.fetchQueue.mockRejectedValueOnce(new Error("サーバーでエラーが発生しました"));
    const user = userEvent.setup();
    render(<MediaReviewApp />);

    expect(await screen.findByText("サーバーでエラーが発生しました")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "もう一度読み込む" }));
    expect(await screen.findByRole("img", { name: "batch/a.png" })).toBeInTheDocument();
  });

  it("ignores rating keys and undo while another queue is loading", async () => {
    const user = userEvent.setup();
    render(<MediaReviewApp />);

    await screen.findByRole("img", { name: "batch/a.png" });
    await user.keyboard("{ArrowRight}");
    await waitFor(() => expect(api.putRating).toHaveBeenCalledTimes(1));

    api.fetchQueue.mockReturnValue(new Promise(() => {}));
    await user.selectOptions(screen.getByRole("combobox", { name: "表示する対象" }), "hold");
    expect(await screen.findByText("読み込んでいます…")).toBeInTheDocument();
    (document.activeElement as HTMLElement | null)?.blur();
    await user.keyboard("{Backspace}{ArrowRight}");

    expect(api.deleteRating).not.toHaveBeenCalled();
    expect(api.putRating).toHaveBeenCalledTimes(1);
  });

  it("does not leave focus on a rating button after a pointer click", async () => {
    const user = userEvent.setup();
    render(<MediaReviewApp />);

    await screen.findByRole("img", { name: "batch/a.png" });
    await user.click(screen.getByRole("button", { name: "マル" }));

    await screen.findByRole("img", { name: "batch/b.png" });
    expect(screen.getByRole("button", { name: "マル" })).not.toHaveFocus();
  });
});
