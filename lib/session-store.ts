import type { Decision, SortMode } from "./media";

export interface ReviewDecision {
  decision: Decision;
  decidedAt: string;
}

export interface ReviewHistoryEntry extends ReviewDecision {
  relativePath: string;
  previousDecision?: ReviewDecision;
}

export interface ReviewSessionV1 {
  schemaVersion: 1;
  id: string;
  rootName: string;
  rootHandle: FileSystemDirectoryHandle;
  manifestFingerprint: string;
  includeSubfolders: boolean;
  sortMode: SortMode;
  randomSeed: number;
  orderedPaths: string[];
  decisions: Record<string, ReviewDecision>;
  history: ReviewHistoryEntry[];
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface SessionMatchCriteria {
  rootHandle: FileSystemDirectoryHandle;
  manifestFingerprint: string;
  includeSubfolders: boolean;
  sortMode?: SortMode;
}

const DATABASE_NAME = "media-viewer";
const DATABASE_VERSION = 1;
const SESSION_STORE = "review-sessions";

function openDatabase(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === "undefined") return Promise.resolve(null);

  return new Promise((resolve) => {
    let request: IDBOpenDBRequest;
    try {
      request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    } catch {
      resolve(null);
      return;
    }

    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(SESSION_STORE)) {
        const store = database.createObjectStore(SESSION_STORE, {
          keyPath: "id",
        });
        store.createIndex("updatedAt", "updatedAt");
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
  });
}

async function runRequest<T>(
  mode: IDBTransactionMode,
  action: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T | null> {
  const database = await openDatabase();
  if (!database) return null;

  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: T | null) => {
      if (settled) return;
      settled = true;
      database.close();
      resolve(value);
    };

    try {
      const transaction = database.transaction(SESSION_STORE, mode);
      const request = action(transaction.objectStore(SESSION_STORE));
      request.onsuccess = () => finish(request.result);
      request.onerror = () => finish(null);
      transaction.onabort = () => finish(null);
      transaction.onerror = () => finish(null);
    } catch {
      finish(null);
    }
  });
}

function isReviewSession(value: unknown): value is ReviewSessionV1 {
  if (!value || typeof value !== "object") return false;
  const session = value as Partial<ReviewSessionV1>;
  return (
    session.schemaVersion === 1 &&
    typeof session.id === "string" &&
    typeof session.rootName === "string" &&
    typeof session.manifestFingerprint === "string" &&
    typeof session.includeSubfolders === "boolean" &&
    Array.isArray(session.orderedPaths) &&
    typeof session.decisions === "object" &&
    Array.isArray(session.history)
  );
}

export async function saveReviewSession(
  session: ReviewSessionV1,
): Promise<boolean> {
  const result = await runRequest<IDBValidKey>("readwrite", (store) =>
    store.put(session),
  );
  return result !== null;
}

export async function listReviewSessions(): Promise<ReviewSessionV1[]> {
  const result = await runRequest<ReviewSessionV1[]>("readonly", (store) =>
    store.getAll(),
  );
  if (!result) return [];
  return result
    .filter(isReviewSession)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export async function deleteReviewSession(id: string): Promise<boolean> {
  const result = await runRequest<undefined>("readwrite", (store) =>
    store.delete(id),
  );
  return result !== null;
}

export async function sessionMatches(
  session: ReviewSessionV1,
  criteria: SessionMatchCriteria,
): Promise<boolean> {
  if (
    session.schemaVersion !== 1 ||
    session.manifestFingerprint !== criteria.manifestFingerprint ||
    session.includeSubfolders !== criteria.includeSubfolders ||
    (criteria.sortMode !== undefined && session.sortMode !== criteria.sortMode)
  ) {
    return false;
  }

  if (session.rootHandle === criteria.rootHandle) return true;
  try {
    return await session.rootHandle.isSameEntry(criteria.rootHandle);
  } catch {
    return false;
  }
}

export async function findMatchingSession(
  criteria: SessionMatchCriteria,
): Promise<ReviewSessionV1 | null> {
  const sessions = await listReviewSessions();
  for (const session of sessions) {
    if (await sessionMatches(session, criteria)) return session;
  }
  return null;
}

// Short aliases keep call sites readable while the explicit names remain primary.
export const saveSession = saveReviewSession;
export const listSessions = listReviewSessions;
export const deleteSession = deleteReviewSession;

