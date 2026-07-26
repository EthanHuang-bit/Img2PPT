import crypto from "node:crypto";

const SAFE_SESSION_ID = /^[A-Za-z0-9_-]{8,128}$/;

export function validateSessionId(value) {
  const sessionId = String(value || "").trim();
  if (!SAFE_SESSION_ID.test(sessionId)) {
    throw new Error("分析会话标识无效，请重新分析图片。");
  }
  return sessionId;
}

export class AnalysisSessionCache {
  #sessions = new Map();

  constructor({
    ttlMs = 2 * 60 * 60 * 1000,
    maxSessions = 24,
    now = () => Date.now()
  } = {}) {
    this.ttlMs = ttlMs;
    this.maxSessions = maxSessions;
    this.now = now;
  }

  create({ sessionId = crypto.randomUUID(), total }) {
    this.prune();
    const id = validateSessionId(sessionId);
    const pageTotal = Number(total);
    if (!Number.isInteger(pageTotal) || pageTotal < 1 || pageTotal > 50) {
      throw new Error("图片总数必须在 1–50 之间。");
    }
    if (!this.#sessions.has(id) && this.#sessions.size >= this.maxSessions) {
      const oldest = [...this.#sessions.entries()]
        .sort((a, b) => a[1].updatedAt - b[1].updatedAt)[0];
      if (oldest) this.#sessions.delete(oldest[0]);
    }
    const existing = this.#sessions.get(id);
    if (existing && existing.total !== pageTotal) {
      throw new Error("分析会话中的图片总数不一致，请重新开始。");
    }
    const session = existing || {
      id,
      total: pageTotal,
      pages: new Map(),
      createdAt: this.now(),
      updatedAt: this.now()
    };
    session.updatedAt = this.now();
    this.#sessions.set(id, session);
    return session;
  }

  setPage(sessionId, index, page) {
    const id = validateSessionId(sessionId);
    const session = this.require(id);
    const pageIndex = Number(index);
    if (!Number.isInteger(pageIndex) || pageIndex < 0 || pageIndex >= session.total) {
      throw new Error("页面序号超出分析会话范围。");
    }
    session.pages.set(pageIndex, {
      ...page,
      index: pageIndex,
      completedAt: this.now()
    });
    session.updatedAt = this.now();
    return this.status(id);
  }

  setQuality(sessionId, quality) {
    const session = this.require(sessionId);
    session.quality = quality;
    session.updatedAt = this.now();
    return quality;
  }

  quality(sessionId) {
    const session = this.require(sessionId);
    if (!session.quality) throw new Error("该会话尚未生成逐页质量报告。");
    return session.quality;
  }

  get(sessionId) {
    this.prune();
    return this.#sessions.get(validateSessionId(sessionId)) || null;
  }

  require(sessionId) {
    const session = this.get(sessionId);
    if (!session) throw new Error("分析缓存已过期，请重新分析图片。");
    return session;
  }

  orderedPages(sessionId, { requireComplete = true } = {}) {
    const session = this.require(sessionId);
    const pages = Array.from({ length: session.total }, (_, index) =>
      session.pages.get(index) || null
    );
    if (requireComplete && pages.some((page) => !page)) {
      const missing = pages
        .map((page, index) => page ? null : index + 1)
        .filter(Boolean);
      throw new Error(`仍有 ${missing.length} 页未完成分析：${missing.join("、")}`);
    }
    return pages;
  }

  status(sessionId) {
    const session = this.require(sessionId);
    const pages = this.orderedPages(sessionId, { requireComplete: false });
    const completed = pages.filter(Boolean).length;
    return {
      sessionId: session.id,
      total: session.total,
      completed,
      progress: Math.round(completed / session.total * 10000) / 100,
      complete: completed === session.total,
      pages: pages.map((page, index) => page ? {
        index,
        name: page.name,
        status: "completed",
        summary: page.analysis?.summary || null
      } : {
        index,
        status: "pending"
      })
    };
  }

  delete(sessionId) {
    return this.#sessions.delete(validateSessionId(sessionId));
  }

  prune() {
    const cutoff = this.now() - this.ttlMs;
    for (const [id, session] of this.#sessions) {
      if (session.updatedAt < cutoff) this.#sessions.delete(id);
    }
  }
}
