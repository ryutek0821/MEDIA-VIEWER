/* eslint-disable @next/next/no-img-element -- local blob URLs cannot use next/image */
"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  createManifestFingerprint,
  scanMediaDirectory,
  sortMediaItems,
  type Decision,
  type MediaItem,
  type ScanMediaResult,
  type SortMode,
} from "../lib/media";
import {
  deleteReviewSession,
  findMatchingSession,
  saveReviewSession,
  type ReviewDecision,
  type ReviewSessionV1,
} from "../lib/session-store";
import { createCsvDecisionRows, saveDecisionsCsv } from "../lib/csv";

type Phase =
  | "idle"
  | "scanning"
  | "resume"
  | "reviewing"
  | "saving"
  | "complete";

interface PendingFolder {
  rootHandle: FileSystemDirectoryHandle;
  scan: ScanMediaResult;
  fingerprint: string;
  includeSubfolders: boolean;
  sortMode: SortMode;
}

type DragStyle = CSSProperties & {
  "--drag-x": string;
  "--drag-rotation": string;
};

const sortLabels: Record<SortMode, string> = {
  name: "ファイル名順",
  oldest: "古い順",
  newest: "新しい順",
  random: "ランダム",
};

const EMPTY_DECISIONS: Record<string, ReviewDecision> = {};

function createSeed(): number {
  const values = new Uint32Array(1);
  crypto.getRandomValues(values);
  return values[0];
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

function makeSession(
  rootHandle: FileSystemDirectoryHandle,
  fingerprint: string,
  includeSubfolders: boolean,
  selectedSort: SortMode,
  seed: number,
  orderedItems: readonly MediaItem[],
): ReviewSessionV1 {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    id: `${fingerprint}-${Date.now()}`,
    rootName: rootHandle.name,
    rootHandle,
    manifestFingerprint: fingerprint,
    includeSubfolders,
    sortMode: selectedSort,
    randomSeed: seed,
    orderedPaths: orderedItems.map((item) => item.relativePath),
    decisions: {},
    history: [],
    createdAt: now,
    updatedAt: now,
    completedAt: null,
  };
}

function isInteractiveTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    Boolean(target.closest("button, input, select, textarea, a, [contenteditable='true']"))
  );
}

export default function MediaReviewApp() {
  const [phase, setPhase] = useState<Phase>("idle");
  const [includeSubfolders, setIncludeSubfolders] = useState(false);
  const [sortMode, setSortMode] = useState<SortMode>("name");
  const [supported, setSupported] = useState<boolean | null>(null);
  const [rootHandle, setRootHandle] = useState<FileSystemDirectoryHandle | null>(null);
  const [items, setItems] = useState<MediaItem[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [session, setSession] = useState<ReviewSessionV1 | null>(null);
  const [pendingFolder, setPendingFolder] = useState<PendingFolder | null>(null);
  const [resumeCandidate, setResumeCandidate] = useState<ReviewSessionV1 | null>(null);
  const [scanSummary, setScanSummary] = useState<ScanMediaResult | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [savedFilename, setSavedFilename] = useState<string | null>(null);
  const [saveDestination, setSaveDestination] = useState<"folder" | "download" | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [mediaUrl, setMediaUrl] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState(false);
  const [dragX, setDragX] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [isPlaying, setIsPlaying] = useState(true);
  const [isMuted, setIsMuted] = useState(true);
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);

  const videoRef = useRef<HTMLVideoElement>(null);
  const dragStartRef = useRef<{ x: number; pointerId: number } | null>(null);
  const busyRef = useRef(false);

  const currentItem = items[currentIndex] ?? null;
  const decisions = session?.decisions ?? EMPTY_DECISIONS;
  const keepCount = useMemo(
    () => Object.values(decisions).filter((value) => value.decision === "keep").length,
    [decisions],
  );
  const rejectCount = useMemo(
    () => Object.values(decisions).filter((value) => value.decision === "reject").length,
    [decisions],
  );
  const progress = items.length ? (currentIndex / items.length) * 100 : 0;

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      setSupported("showDirectoryPicker" in window);
    });
    return () => cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    let disposed = false;
    let nextUrl: string | null = null;

    if (!currentItem || phase !== "reviewing") {
      queueMicrotask(() => {
        if (!disposed) setMediaUrl(null);
      });
      return () => {
        disposed = true;
      };
    }

    queueMicrotask(() => {
      if (disposed) return;
      setPreviewError(false);
      setMediaUrl(null);
      setCurrentTime(0);
      setDuration(0);
      setIsPlaying(true);
      setIsMuted(true);
    });

    currentItem.handle
      .getFile()
      .then((file) => {
        if (disposed) return;
        nextUrl = URL.createObjectURL(file);
        setMediaUrl(nextUrl);
      })
      .catch(() => {
        if (!disposed) setPreviewError(true);
      });

    return () => {
      disposed = true;
      if (nextUrl) URL.revokeObjectURL(nextUrl);
    };
  }, [currentItem, phase]);

  const persistSession = useCallback(async (nextSession: ReviewSessionV1) => {
    setSession(nextSession);
    const saved = await saveReviewSession(nextSession);
    if (!saved) {
      setWarning("途中経過を保存できません。このタブは閉じずに続けてください。");
    }
  }, []);

  const beginNewReview = useCallback(
    async (folder: PendingFolder, replaceSession?: ReviewSessionV1) => {
      if (replaceSession) await deleteReviewSession(replaceSession.id);
      const seed = createSeed();
      const orderedItems = sortMediaItems(folder.scan.items, folder.sortMode, seed);
      const nextSession = makeSession(
        folder.rootHandle,
        folder.fingerprint,
        folder.includeSubfolders,
        folder.sortMode,
        seed,
        orderedItems,
      );
      setIncludeSubfolders(folder.includeSubfolders);
      setSortMode(folder.sortMode);
      setRootHandle(folder.rootHandle);
      setItems(orderedItems);
      setCurrentIndex(0);
      setScanSummary(folder.scan);
      setPendingFolder(null);
      setResumeCandidate(null);
      setMessage(null);
      setWarning(null);
      setSavedFilename(null);
      setSaveDestination(null);
      setSaveError(null);
      await persistSession(nextSession);
      setPhase("reviewing");
    },
    [persistSession],
  );

  const resumeReview = useCallback(async () => {
    if (!pendingFolder || !resumeCandidate) return;
    const byPath = new Map(
      pendingFolder.scan.items.map((item) => [item.relativePath, item]),
    );
    const orderedItems = resumeCandidate.orderedPaths
      .map((path) => byPath.get(path))
      .filter((item): item is MediaItem => Boolean(item));

    if (orderedItems.length !== pendingFolder.scan.items.length) {
      setMessage("フォルダの内容が変わったため、最初から仕分けを開始します。");
      await beginNewReview(pendingFolder, resumeCandidate);
      return;
    }

    setSortMode(resumeCandidate.sortMode);
    setIncludeSubfolders(resumeCandidate.includeSubfolders);
    setRootHandle(pendingFolder.rootHandle);
    setItems(orderedItems);
    setCurrentIndex(resumeCandidate.history.length);
    setSession({ ...resumeCandidate, rootHandle: pendingFolder.rootHandle });
    setScanSummary(pendingFolder.scan);
    setPendingFolder(null);
    setResumeCandidate(null);
    setWarning(null);
    setSavedFilename(null);
    setSaveDestination(null);
    setSaveError(null);
    setPhase(
      resumeCandidate.history.length >= orderedItems.length
        ? "complete"
        : "reviewing",
    );
  }, [beginNewReview, pendingFolder, resumeCandidate]);

  const chooseFolder = useCallback(async () => {
    if (!("showDirectoryPicker" in window)) {
      setSupported(false);
      return;
    }

    const scanIncludesSubfolders = includeSubfolders === true;
    const scanSortMode = sortMode;

    try {
      const handle = await window.showDirectoryPicker({
        id: "media-review-root",
        mode: "readwrite",
        startIn: "pictures",
      });
      setPhase("scanning");
      setMessage(null);
      setWarning(null);
      const scan = await scanMediaDirectory(handle, {
        recursive: scanIncludesSubfolders,
      });

      if (scan.items.length === 0) {
        setScanSummary(scan);
        setPhase("idle");
        setMessage(
          scan.errors.length
            ? "フォルダを読み取れませんでした。権限を確認して、もう一度選んでください。"
            : "対応している画像・動画が見つかりませんでした。",
        );
        return;
      }

      const fingerprint = await createManifestFingerprint(
        handle.name,
        scanIncludesSubfolders,
        scan.items,
      );
      const folder = {
        rootHandle: handle,
        scan,
        fingerprint,
        includeSubfolders: scanIncludesSubfolders,
        sortMode: scanSortMode,
      };
      const matching = await findMatchingSession({
        rootHandle: handle,
        manifestFingerprint: fingerprint,
        includeSubfolders: scanIncludesSubfolders,
      });

      if (
        matching &&
        !matching.completedAt &&
        matching.history.length > 0 &&
        matching.history.length <= matching.orderedPaths.length
      ) {
        setPendingFolder(folder);
        setResumeCandidate(matching);
        setPhase("resume");
        return;
      }

      await beginNewReview(folder, matching ?? undefined);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      setPhase("idle");
      setMessage("フォルダを開けませんでした。Chromeのフォルダ権限を確認してください。");
    }
  }, [beginNewReview, includeSubfolders, sortMode]);

  const saveCompletedReview = useCallback(
    async (nextSession: ReviewSessionV1) => {
      if (!rootHandle) return;
      setPhase("saving");
      setSaveError(null);
      try {
        const rows = createCsvDecisionRows(items, nextSession.decisions);
        const saveResult = await saveDecisionsCsv(rootHandle, rows);
        const now = new Date().toISOString();
        const completed = { ...nextSession, updatedAt: now, completedAt: now };
        await persistSession(completed);
        setSavedFilename(saveResult.filename);
        setSaveDestination(saveResult.destination);
        setPhase("complete");
      } catch {
        setSaveError("CSVを保存できませんでした。権限を確認して再試行してください。");
        setPhase("complete");
      }
    },
    [items, persistSession, rootHandle],
  );

  const decide = useCallback(
    async (decision: Decision) => {
      if (!session || !currentItem || phase !== "reviewing" || busyRef.current) return;
      busyRef.current = true;
      const decidedAt = new Date().toISOString();
      const record: ReviewDecision = { decision, decidedAt };
      const previousDecision = session.decisions[currentItem.relativePath];
      const nextIndex = currentIndex + 1;
      const nextSession: ReviewSessionV1 = {
        ...session,
        decisions: {
          ...session.decisions,
          [currentItem.relativePath]: record,
        },
        history: [
          ...session.history,
          {
            relativePath: currentItem.relativePath,
            ...record,
            ...(previousDecision ? { previousDecision } : {}),
          },
        ],
        updatedAt: decidedAt,
        completedAt: null,
      };

      setDragX(decision === "keep" ? window.innerWidth : -window.innerWidth);
      await persistSession(nextSession);
      setCurrentIndex(nextIndex);
      setDragX(0);
      setDragging(false);

      if (nextIndex >= items.length) await saveCompletedReview(nextSession);
      busyRef.current = false;
    },
    [currentIndex, currentItem, items.length, persistSession, phase, saveCompletedReview, session],
  );

  const undo = useCallback(async () => {
    if (!session || session.history.length === 0 || busyRef.current) return;
    busyRef.current = true;
    const history = [...session.history];
    const last = history.pop();
    if (!last) {
      busyRef.current = false;
      return;
    }
    const nextDecisions = { ...session.decisions };
    if (last.previousDecision) {
      nextDecisions[last.relativePath] = last.previousDecision;
    } else {
      delete nextDecisions[last.relativePath];
    }
    const now = new Date().toISOString();
    const nextSession: ReviewSessionV1 = {
      ...session,
      decisions: nextDecisions,
      history,
      updatedAt: now,
      completedAt: null,
    };
    setSavedFilename(null);
    setSaveDestination(null);
    setSaveError(null);
    setCurrentIndex(history.length);
    setPhase("reviewing");
    await persistSession(nextSession);
    busyRef.current = false;
  }, [persistSession, session]);

  const retrySave = useCallback(async () => {
    if (session && session.history.length === items.length) {
      await saveCompletedReview(session);
    }
  }, [items.length, saveCompletedReview, session]);

  const toggleVideo = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) {
      void video.play().then(() => setIsPlaying(true)).catch(() => setIsPlaying(false));
    } else {
      video.pause();
      setIsPlaying(false);
    }
  }, []);

  const toggleMute = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    video.muted = !video.muted;
    setIsMuted(video.muted);
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (isInteractiveTarget(event.target)) return;
      if (event.repeat) return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") {
        event.preventDefault();
        void undo();
        return;
      }
      if (event.key === "Backspace") {
        event.preventDefault();
        void undo();
      } else if (event.key === "ArrowLeft") {
        event.preventDefault();
        void decide("reject");
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        void decide("keep");
      } else if (event.code === "Space" && currentItem?.kind === "video") {
        event.preventDefault();
        toggleVideo();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [currentItem?.kind, decide, toggleVideo, undo]);

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (phase !== "reviewing" || busyRef.current || isInteractiveTarget(event.target)) return;
    dragStartRef.current = { x: event.clientX, pointerId: event.pointerId };
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragging(true);
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragStartRef.current || dragStartRef.current.pointerId !== event.pointerId) return;
    setDragX(event.clientX - dragStartRef.current.x);
  };

  const onPointerEnd = (event: ReactPointerEvent<HTMLDivElement>) => {
    const start = dragStartRef.current;
    if (!start || start.pointerId !== event.pointerId) return;
    dragStartRef.current = null;
    const delta = event.clientX - start.x;
    const threshold = event.currentTarget.getBoundingClientRect().width * 0.25;
    if (Math.abs(delta) >= threshold) {
      void decide(delta > 0 ? "keep" : "reject");
      return;
    }
    setDragX(0);
    setDragging(false);
  };

  const onPointerCancel = () => {
    dragStartRef.current = null;
    setDragX(0);
    setDragging(false);
  };

  const dragStyle: DragStyle = {
    "--drag-x": `${dragX}px`,
    "--drag-rotation": `${dragX / 48}deg`,
  };
  const dragStrength = Math.min(Math.abs(dragX) / 180, 1);
  const ignoredExtensions = scanSummary
    ? Object.entries(scanSummary.ignoredExtensions)
        .map(([extension, count]) => `.${extension} ${count}件`)
        .join("、")
    : "";

  if (phase === "scanning") {
    return (
      <main className="center-shell" aria-live="polite">
        <div className="scan-indicator" aria-hidden="true" />
        <p className="step-label">フォルダを確認中</p>
        <h1 className="state-title">メディアを探しています</h1>
        <p className="state-copy">ファイルはこの端末から送信されません。</p>
      </main>
    );
  }

  if (phase === "resume" && pendingFolder && resumeCandidate) {
    return (
      <main className="center-shell">
        <p className="step-label">途中の仕分けが見つかりました</p>
        <h1 className="state-title">{pendingFolder.rootHandle.name}</h1>
        <p className="state-copy">
          {resumeCandidate.history.length} / {resumeCandidate.orderedPaths.length} 件まで完了しています。
          <br />前回の「{sortLabels[resumeCandidate.sortMode]}」を引き継げます。
        </p>
        <div className="state-actions">
          <button className="primary-action" type="button" onClick={() => void resumeReview()}>
            続きから
          </button>
          <button
            className="secondary-action"
            type="button"
            onClick={() => void beginNewReview(pendingFolder, resumeCandidate)}
          >
            最初から
          </button>
        </div>
      </main>
    );
  }

  if ((phase === "complete" || phase === "saving") && session) {
    return (
      <main className="center-shell complete-shell">
        <div className="complete-mark" aria-hidden="true">✓</div>
        <p className="step-label">仕分け完了</p>
        <h1 className="state-title">{items.length}件を判定しました</h1>
        <div className="result-counts">
          <span><strong>{keepCount}</strong> いる</span>
          <span><strong>{rejectCount}</strong> いらない</span>
        </div>
        {phase === "saving" ? (
          <p className="state-copy">CSVを保存しています…</p>
        ) : savedFilename ? (
          <p className="state-copy">
            <strong>{savedFilename}</strong><br />
            {saveDestination === "folder"
              ? "を選択フォルダへ保存しました。"
              : "のダウンロードを開始しました。"}
          </p>
        ) : (
          <p className="error-message">{saveError ?? "CSVはまだ保存されていません。"}</p>
        )}
        <div className="state-actions">
          {!savedFilename && (
            <button className="primary-action" type="button" onClick={() => void retrySave()}>
              CSV保存を再試行
            </button>
          )}
          <button className="secondary-action" type="button" onClick={() => void undo()}>
            最後の判定に戻る
          </button>
          <button className="text-action" type="button" onClick={() => void chooseFolder()}>
            別のフォルダを選ぶ
          </button>
        </div>
      </main>
    );
  }

  if (phase === "reviewing" && currentItem) {
    return (
      <main className="review-shell">
        <header className="review-header">
          <div className="review-brand">
            <span className="brand-mark" aria-hidden="true" />
            <span className="folder-name">{rootHandle?.name}</span>
            <span className="scope-badge">
              {session?.includeSubfolders ? "サブフォルダ込み" : "直下のみ"}
            </span>
          </div>
          <div className="progress-copy" aria-live="polite">
            <strong>{currentIndex + 1}</strong> / {items.length}
          </div>
          <div className="header-actions">
            <button className="header-button" type="button" onClick={() => void undo()} disabled={!session?.history.length}>
              元に戻す
            </button>
            <button className="header-button" type="button" onClick={() => void chooseFolder()}>
              別のフォルダ
            </button>
          </div>
        </header>
        <div className="progress-track" aria-hidden="true">
          <span style={{ width: `${progress}%` }} />
        </div>

        <section className="review-workbench">
          <button className="edge-action reject-edge" type="button" onClick={() => void decide("reject")}>
            <span>←</span><strong>いらない</strong><small>{rejectCount}</small>
          </button>

          <div className="media-column">
            <div
              className={`media-card${dragging ? " is-dragging" : ""}`}
              style={dragStyle}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerEnd}
              onPointerCancel={onPointerCancel}
            >
              <div
                className="decision-stamp reject-stamp"
                style={{ opacity: dragX < 0 ? dragStrength : 0 }}
              >
                いらない
              </div>
              <div
                className="decision-stamp keep-stamp"
                style={{ opacity: dragX > 0 ? dragStrength : 0 }}
              >
                いる
              </div>
              {mediaUrl && !previewError ? (
                currentItem.kind === "image" ? (
                  <img src={mediaUrl} alt={currentItem.name} draggable={false} onError={() => setPreviewError(true)} />
                ) : (
                  <video
                    ref={videoRef}
                    src={mediaUrl}
                    autoPlay
                    muted
                    loop
                    playsInline
                    preload="metadata"
                    onPlay={() => setIsPlaying(true)}
                    onPause={() => setIsPlaying(false)}
                    onLoadedMetadata={(event) => setDuration(event.currentTarget.duration || 0)}
                    onTimeUpdate={(event) => setCurrentTime(event.currentTarget.currentTime)}
                    onError={() => setPreviewError(true)}
                  />
                )
              ) : previewError ? (
                <div className="preview-error">
                  <strong>プレビューできません</strong>
                  <span>ファイル名を確認して判定できます。</span>
                </div>
              ) : (
                <div className="media-loading" aria-label="メディアを読み込み中" />
              )}
            </div>

            <div className="media-caption">
              <div>
                <strong title={currentItem.relativePath}>{currentItem.name}</strong>
                <span>{formatBytes(currentItem.sizeBytes)} ・ {currentItem.kind === "image" ? "画像" : "動画"}</span>
              </div>
              {currentItem.kind === "video" && (
                <div className="video-controls">
                  <button type="button" onClick={toggleVideo}>{isPlaying ? "一時停止" : "再生"}</button>
                  <input
                    aria-label="動画の再生位置"
                    type="range"
                    min="0"
                    max={Math.max(duration, 0)}
                    step="0.1"
                    value={Math.min(currentTime, duration || 0)}
                    onChange={(event) => {
                      const nextTime = Number(event.currentTarget.value);
                      if (videoRef.current) videoRef.current.currentTime = nextTime;
                      setCurrentTime(nextTime);
                    }}
                  />
                  <button type="button" onClick={toggleMute}>{isMuted ? "音を出す" : "消音"}</button>
                </div>
              )}
            </div>
            <p className="shortcut-hint">← いらない / → いる / ⌘Z 元に戻す</p>
          </div>

          <button className="edge-action keep-edge" type="button" onClick={() => void decide("keep")}>
            <span>→</span><strong>いる</strong><small>{keepCount}</small>
          </button>
        </section>
        {warning && <p className="floating-warning" role="status">{warning}</p>}
      </main>
    );
  }

  return (
    <main className="landing-shell">
      <header className="brand-line">
        <span className="brand-mark" aria-hidden="true" />
        <span>メディア仕分け</span>
        <span className="privacy-note">端末内だけで処理</span>
      </header>
      <section className="intro-stage">
        <div className="intro-copy">
          <p className="step-label">フォルダをひとつ選ぶ</p>
          <h1>残したい一枚を、<br />迷わず選ぶ。</h1>
          <p className="intro-description">
            画像と動画を左右に仕分け、最後に判定結果をCSVで保存します。
            元のメディアは変更しません。
          </p>

          <div className="review-options">
            <label className="toggle-row">
              <input
                type="checkbox"
                checked={includeSubfolders}
                onChange={(event) => setIncludeSubfolders(event.currentTarget.checked)}
              />
              <span className="toggle-control" aria-hidden="true" />
              <span>サブフォルダも含める</span>
            </label>
            <label className="sort-field">
              <span>表示順</span>
              <select value={sortMode} onChange={(event) => setSortMode(event.currentTarget.value as SortMode)}>
                {Object.entries(sortLabels).map(([value, label]) => (
                  <option key={value} value={value}>{label}</option>
                ))}
              </select>
            </label>
          </div>

          <button className="folder-button" type="button" onClick={() => void chooseFolder()} disabled={supported === false}>
            フォルダを選ぶ
          </button>
          {supported === false ? (
            <p className="error-message">この機能はChromeまたはEdgeで開いてください。</p>
          ) : (
            <p className="support-note">Chrome / Edge ・ JPG / PNG / WebP / GIF / AVIF / MP4 / WebM</p>
          )}
          {message && <p className="error-message" role="status">{message}</p>}
          {scanSummary && scanSummary.ignoredCount > 0 && (
            <p className="ignored-note">
              対象外 {scanSummary.ignoredCount}件{ignoredExtensions ? `（${ignoredExtensions}）` : ""}
            </p>
          )}
        </div>

        <div className="preview-board" aria-label="仕分け操作のプレビュー">
          <span className="decision-rail reject">← いらない</span>
          <div className="preview-frame">
            <div className="preview-sun" />
            <div className="preview-horizon" />
            <span>IMG_0248.JPG</span>
          </div>
          <span className="decision-rail keep">いる →</span>
        </div>
      </section>
    </main>
  );
}
