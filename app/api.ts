import type { QueueItem, QueueMode, Rating, RatingStats } from "../lib/media.ts";

export interface QueueResponse {
  mode: QueueMode;
  items: QueueItem[];
  stats: RatingStats;
  scanError: string | null;
}

async function request(url: string, init?: RequestInit): Promise<Response> {
  const response = await fetch(url, init);
  if (response.ok) return response;
  let message = `HTTP ${response.status}`;
  try {
    const body = (await response.json()) as { error?: unknown };
    if (typeof body.error === "string") message = body.error;
  } catch {
    // Keep the status-code message when the body is not JSON.
  }
  throw new Error(message);
}

export async function fetchQueue(mode: QueueMode): Promise<QueueResponse> {
  const response = await request(`/api/queue?mode=${encodeURIComponent(mode)}`);
  return (await response.json()) as QueueResponse;
}

export async function putRating(sha256: string, rating: Rating): Promise<void> {
  await request(`/api/ratings/${sha256}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ rating }),
  });
}

export async function deleteRating(sha256: string): Promise<void> {
  await request(`/api/ratings/${sha256}`, { method: "DELETE" });
}

export function mediaUrl(sha256: string): string {
  return `/media/${sha256}`;
}
