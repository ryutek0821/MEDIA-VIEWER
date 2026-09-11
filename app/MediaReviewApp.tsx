import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import type { QueueItem, QueueMode, Rating, RatingStats } from "../lib/media.ts";
import { fetchQueue, mediaUrl, putRating } from "./api.ts";

const REFRESH_INTERVAL_MS = 30_000;
const HISTORY_LIMIT = 200;
const PRELOAD_COUNT = 2;
const MIN_SWIPE_PX = 48;

const MODE_OPTIONS: ReadonlyArray<{ value: QueueMode; label: string }> = [
  { value: "unrated", label: "未評価" },
  { value: "hold", label: "保留を見直す" },
  { value: "all", label: "すべて" },
];

const RATING_LABELS: Readonly<Record<Rating, string>> = {
  reject: "バツ",
  keep: "マル",
  hold: "保留",
};

const RATING_SYMBOLS: Readonly<Record<Rating, string>> = {
  reject: "✕",
  keep: "◯",
  hold: "△",
};

const RATING_KEYS: Readonly<Record<Rating, string>> = {
  reject: "ArrowLeft",
  hold: "ArrowDown",
  keep: "ArrowRight",
};

const BUTTON_ORDER: readonly Rating[] = ["reject", "hold", "keep"];
const KEY_TO_RATING = new Map(BUTTON_ORDER.map((rating) => [RATING_KEYS[rating], rating]));

type DragStyle = CSSProperties & Record<"--drag-x" | "--drag-y" | "--drag-rotation", string>;
type LoadStatus = "loading" | "ready" | "error";

interface DragOffset {
  x: number;
  y: number;
}

interface HistoryEntry {
  item: QueueItem;
  rating: Rating;
}

const NO_DRAG: DragOffset = { x: 0, y: 0 };

const modifiedFormatter = new Intl.DateTimeFormat("ja-JP", {
  dateStyle: "short",
  timeStyle: "short",
});

function isTextEntryTarget(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    target.closest("input, select, textarea, [contenteditable='true']") !== null
  );
}

function isControlTarget(target: EventTarget | null): boolean {
  return (
    target instanceof Element && target.closest("a, button, input, select, textarea") !== null
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function adjustStats(
  stats: RatingStats | null,
  from: Rating | null,
  to: Rating | null,
): RatingStats | null {
  if (!stats || from === to) return stats;
  const next = { ...stats };
  if (from === null) next.unrated -= 1;
  else next[from] -= 1;
  if (to === null) next.unrated += 1;
  else next[to] += 1;
  return next;
}

function dragDirection({ x, y }: DragOffset): Rating | null {
  if (Math.abs(x) >= Math.abs(y)) {
    if (x === 0) return null;
    return x > 0 ? "keep" : "reject";
  }
  return y < 0 ? "hold" : null;
}

/** Horizontal swipes choose バツ / マル; an upward swipe chooses 保留. */
function ratingFromDrag(offset: DragOffset, width: number, height: number): Rating | null {
  const direction = dragDirection(offset);
  if (direction === "hold") {
    return -offset.y >= Math.max(height * 0.18, MIN_SWIPE_PX) ? "hold" : null;
  }
  if (direction) {
    return Math.abs(offset.x) >= Math.max(width * 0.25, MIN_SWIPE_PX) ? direction : null;
  }
  return null;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** After a mouse/touch click, a focused button would turn a later Space into another click. */
function releasePointerFocus(event: ReactMouseEvent<HTMLButtonElement>): void {
  if (event.detail > 0) event.currentTarget.blur();
}

export default function MediaReviewApp() {
  const [mode, setMode] = useState<QueueMode>("unrated");
  const [status, setStatus] = useState<LoadStatus>("loading");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pending, setPending] = useState<QueueItem[]>([]);
  const [historyLength, setHistoryLength] = useState(0);
  const [stats, setStats] = useState<RatingStats | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [drag, setDrag] = useState<DragOffset>(NO_DRAG);
  const [dragging, setDragging] = useState(false);
  const [failedSha, setFailedSha] = useState<string | null>(null);
  const [pausedSha, setPausedSha] = useState<string | null>(null);
  const [muted, setMuted] = useState(true);

  // Refs mirror state so rapid key presses always act on the latest queue.
  const pendingRef = useRef<QueueItem[]>([]);
  const historyRef = useRef<HistoryEntry[]>([]);
  const reviewedRef = useRef(new Set<string>());
  const requestChainRef = useRef<Promise<void>>(Promise.resolve());
  const generationRef = useRef(0);
  const modeRef = useRef(mode);
  const dragStartRef = useRef<{ x: number; y: number; pointerId: number } | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);

  const commitPending = useCallback((next: QueueItem[]) => {
    pendingRef.current = next;
    setPending(next);
  }, []);

  const commitHistory = useCallback((next: HistoryEntry[]) => {
    historyRef.current = next;
    setHistoryLength(next.length);
  }, []);

  const loadQueue = useCallback(
    async (reset: boolean) => {
      const generation = reset ? ++generationRef.current : generationRef.current;
      const requestedMode = modeRef.current;
      try {
        // Let queued rating writes land first so the server's view is current.
        await requestChainRef.current;
        const response = await fetchQueue(requestedMode);
        if (generation !== generationRef.current) return;

        setStats(response.stats);
        setScanError(response.scanError);
        if (reset) {
          reviewedRef.current = new Set();
          commitHistory([]);
          commitPending(response.items);
        } else {
          // Drop items rated elsewhere (except the one on screen) and append new arrivals.
          const fresh = new Map(response.items.map((item) => [item.sha256, item]));
          const kept = pendingRef.current
            .filter((item, index) => index === 0 || fresh.has(item.sha256))
            .map((item) => fresh.get(item.sha256) ?? item);
          const keptShas = new Set(kept.map((item) => item.sha256));
          const additions = response.items.filter(
            (item) => !keptShas.has(item.sha256) && !reviewedRef.current.has(item.sha256),
          );
          commitPending([...kept, ...additions]);
        }
        setLoadError(null);
        setStatus("ready");
      } catch (error) {
        if (generation !== generationRef.current) return;
        if (reset) {
          // Nothing stale may stay rateable (by key or going back) behind the error screen.
          commitPending([]);
          commitHistory([]);
          setLoadError(errorMessage(error));
          setStatus("error");
        } else {
          setNotice(`新着を確認できませんでした（${errorMessage(error)}）`);
        }
      }
    },
    [commitHistory, commitPending],
  );

  useEffect(() => {
    modeRef.current = mode;
    void loadQueue(true);
  }, [mode, loadQueue]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      void loadQueue(false);
    }, REFRESH_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [loadQueue]);

  /** Sends writes one at a time so quickly re-rating an item reaches the server in order. */
  const enqueueRequest = useCallback(
    (send: () => Promise<void>) => {
      requestChainRef.current = requestChainRef.current.then(send).catch((error: unknown) => {
        setNotice(`評価を保存できませんでした（${errorMessage(error)}）。一覧を読み直しました。`);
        window.setTimeout(() => {
          void loadQueue(true);
        }, 0);
      });
    },
    [loadQueue],
  );

  const resetDrag = useCallback(() => {
    dragStartRef.current = null;
    setDrag(NO_DRAG);
    setDragging(false);
  }, []);

  const decide = useCallback(
    (rating: Rating) => {
      const [item, ...rest] = pendingRef.current;
      if (!item) return;
      commitPending(rest);
      commitHistory([...historyRef.current, { item, rating }].slice(-HISTORY_LIMIT));
      reviewedRef.current.add(item.sha256);
      setStats((current) => adjustStats(current, item.rating, rating));
      resetDrag();
      enqueueRequest(() => putRating(item.sha256, rating));
    },
    [commitHistory, commitPending, enqueueRequest, resetDrag],
  );

  /**
   * Shows the previously rated item again. Its saved rating is kept (and shown in the
   * caption); rating it again simply overwrites it, so going back never loses data.
   */
  const goBack = useCallback(() => {
    const entry = historyRef.current.at(-1);
    if (!entry) return;
    const item: QueueItem = { ...entry.item, rating: entry.rating };
    commitHistory(historyRef.current.slice(0, -1));
    commitPending([item, ...pendingRef.current.filter((other) => other.sha256 !== item.sha256)]);
    reviewedRef.current.delete(item.sha256);
    resetDrag();
  }, [commitHistory, commitPending, resetDrag]);

  const toggleVideo = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) {
      setPausedSha(null);
      void video.play()?.catch(() => undefined);
    } else {
      video.pause();
      setPausedSha(video.dataset.sha ?? null);
    }
  }, []);

  const currentSha = pending[0]?.sha256 ?? null;

  useEffect(() => {
    if (videoRef.current) videoRef.current.muted = muted;
  }, [muted, currentSha]);

  useEffect(() => {
    for (const item of pending.slice(1, 1 + PRELOAD_COUNT)) {
      if (item.kind === "image") new Image().src = mediaUrl(item.sha256);
    }
  }, [pending]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.repeat || event.altKey || isTextEntryTarget(event.target)) return;
      if (event.metaKey || event.ctrlKey) {
        if (event.key.toLowerCase() === "z") {
          event.preventDefault();
          goBack();
        }
        return;
      }
      const rating = KEY_TO_RATING.get(event.key);
      if (rating) {
        event.preventDefault();
        decide(rating);
      } else if (event.key === "Backspace") {
        event.preventDefault();
        goBack();
      } else if (event.code === "Space" && !isControlTarget(event.target)) {
        event.preventDefault();
        toggleVideo();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [decide, goBack, toggleVideo]);

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || isControlTarget(event.target)) return;
    dragStartRef.current = { x: event.clientX, y: event.clientY, pointerId: event.pointerId };
    event.currentTarget.setPointerCapture?.(event.pointerId);
    setDragging(true);
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const start = dragStartRef.current;
    if (!start || start.pointerId !== event.pointerId) return;
    setDrag({ x: event.clientX - start.x, y: event.clientY - start.y });
  };

  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    const start = dragStartRef.current;
    if (!start || start.pointerId !== event.pointerId) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const rating = ratingFromDrag(
      { x: event.clientX - start.x, y: event.clientY - start.y },
      rect.width,
      rect.height,
    );
    if (rating) decide(rating);
    else resetDrag();
  };

  const onModeChange = (event: ChangeEvent<HTMLSelectElement>) => {
    // Drop the previous mode's queue at once (and ignore refreshes still in flight),
    // so keys or going back cannot act on items that are no longer on screen.
    generationRef.current += 1;
    commitPending([]);
    commitHistory([]);
    setStatus("loading");
    setMode(event.target.value as QueueMode);
  };

  const retry = () => {
    setStatus("loading");
    void loadQueue(true);
  };

  const current = pending[0] ?? null;
  const direction = dragDirection(drag);
  const dragStrength = Math.min(Math.max(Math.abs(drag.x), -drag.y) / 180, 1);
  const dragStyle: DragStyle = {
    "--drag-x": `${drag.x}px`,
    "--drag-y": `${Math.min(drag.y, 0)}px`,
    "--drag-rotation": `${drag.x / 48}deg`,
  };

  return (
    <div className="review-shell">
      <header className="review-header">
        <div className="review-brand">
          <span className="brand-mark" aria-hidden="true" />
          <span className="app-name">MARIN 評価</span>
        </div>
        <div className="header-actions">
          <label className="mode-field">
            <span className="sr-only">表示する対象</span>
            <select value={mode} onChange={onModeChange}>
              {MODE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <a className="header-button" href="/api/export.csv" download>
            CSV
          </a>
        </div>
      </header>

      <p className="stats-bar" aria-live="polite">
        {status === "ready" ? (
          <span>
            残り <strong>{pending.length}</strong>
          </span>
        ) : null}
        {stats ? (
          <>
            <span className="stat-reject">✕ {stats.reject}</span>
            <span className="stat-hold">△ {stats.hold}</span>
            <span className="stat-keep">◯ {stats.keep}</span>
            <span>未評価 {stats.unrated}</span>
          </>
        ) : null}
      </p>

      {status === "loading" ? (
        <main className="center-shell">
          <div className="scan-indicator" aria-hidden="true" />
          <p className="state-copy" role="status">
            読み込んでいます…
          </p>
        </main>
      ) : status === "error" ? (
        <main className="center-shell">
          <h1 className="state-title">読み込めませんでした</h1>
          <p className="state-copy">{loadError}</p>
          <div className="state-actions">
            <button type="button" className="primary-action" onClick={retry}>
              もう一度読み込む
            </button>
          </div>
        </main>
      ) : current ? (
        <>
          <main className="review-stage">
            <div
              className={`media-card${dragging ? " is-dragging" : ""}`}
              style={dragStyle}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={resetDrag}
            >
              {direction && dragStrength > 0.05 ? (
                <span
                  className={`decision-stamp ${direction}-stamp`}
                  style={{ opacity: dragStrength }}
                  aria-hidden="true"
                >
                  {RATING_SYMBOLS[direction]} {RATING_LABELS[direction]}
                </span>
              ) : null}
              {failedSha === current.sha256 ? (
                <div className="preview-error">
                  <strong>表示できません</strong>
                  <span>ファイル名を確認して評価できます</span>
                </div>
              ) : current.kind === "image" ? (
                // eslint-disable-next-line @next/next/no-img-element -- plain Vite SPA; next/image does not apply
                <img
                  key={current.sha256}
                  src={mediaUrl(current.sha256)}
                  alt={current.relPath}
                  draggable={false}
                  onError={() => setFailedSha(current.sha256)}
                />
              ) : (
                <video
                  key={current.sha256}
                  ref={videoRef}
                  data-sha={current.sha256}
                  src={mediaUrl(current.sha256)}
                  aria-label={current.relPath}
                  autoPlay
                  loop
                  muted
                  playsInline
                  preload="auto"
                  onError={() => setFailedSha(current.sha256)}
                />
              )}
            </div>
            <div className="media-caption">
              <div>
                <strong title={current.relPath}>{current.relPath}</strong>
                <span>
                  {modifiedFormatter.format(current.mtimeMs)} ・ {formatBytes(current.sizeBytes)}
                  {current.rating ? ` ・ 現在の評価: ${RATING_LABELS[current.rating]}` : ""}
                </span>
              </div>
              {current.kind === "video" && failedSha !== current.sha256 ? (
                <div className="video-controls">
                  <button type="button" onClick={toggleVideo}>
                    {pausedSha === current.sha256 ? "再生" : "一時停止"}
                  </button>
                  <button type="button" onClick={() => setMuted((value) => !value)}>
                    {muted ? "音声オン" : "消音"}
                  </button>
                </div>
              ) : null}
            </div>
          </main>
          <nav className="rating-bar" aria-label="評価">
            <button
              type="button"
              className="back-button"
              aria-keyshortcuts="Backspace"
              disabled={historyLength === 0}
              onClick={(event) => {
                releasePointerFocus(event);
                goBack();
              }}
            >
              <span aria-hidden="true">↩</span>
              戻る
            </button>
            {BUTTON_ORDER.map((rating) => (
              <button
                key={rating}
                type="button"
                className={`rating-button ${rating}`}
                aria-keyshortcuts={RATING_KEYS[rating]}
                onClick={(event) => {
                  releasePointerFocus(event);
                  decide(rating);
                }}
              >
                <span aria-hidden="true">{RATING_SYMBOLS[rating]}</span>
                {RATING_LABELS[rating]}
              </button>
            ))}
          </nav>
          <p className="shortcut-hint">← バツ ・ ↓ 保留 ・ → マル ・ Backspace で1枚戻る</p>
        </>
      ) : (
        <main className="center-shell">
          <div className="complete-mark" aria-hidden="true">
            ✓
          </div>
          <h1 className="state-title">
            {mode === "hold" ? "保留はありません" : "評価待ちはありません"}
          </h1>
          <p className="state-copy">新しい画像・動画が届いていないか、30秒ごとに確認しています。</p>
          {historyLength > 0 ? (
            <div className="state-actions">
              <button type="button" className="secondary-action" onClick={goBack}>
                ↩ 1枚戻る
              </button>
            </div>
          ) : null}
        </main>
      )}

      {scanError || notice ? (
        <div className="floating-stack">
          {scanError ? (
            <p className="floating-warning" role="alert">
              フォルダを読み込めません: {scanError}
            </p>
          ) : null}
          {notice ? (
            <p className="floating-warning" role="alert">
              {notice}
              <button type="button" onClick={() => setNotice(null)}>
                閉じる
              </button>
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
