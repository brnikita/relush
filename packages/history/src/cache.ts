import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Content-addressed cache for reversible history operations (SPEC §4.4).
 *
 * Masking and compression are only acceptable because they are reversible: the
 * model sees `[output masked: 4,210 tokens, sha=…]` and can call `expand(sha)`
 * to get the original back verbatim. That guarantee lives here, so this module
 * has one hard rule — **what goes in comes out byte-identical**, including
 * trailing whitespace, CRLF line endings, and invalid UTF-8.
 *
 * Content is therefore stored and returned as `Buffer`, never as a decoded
 * string. A round trip through `string` would normalize lone surrogates and
 * silently corrupt binary tool output.
 */

/** Length of the hex digest kept as an id. */
const DIGEST_LENGTH = 32;

/**
 * Hash algorithm.
 *
 * SPEC §4.2 names XXH3. This uses BLAKE2b from `node:crypto` instead, because
 * it needs no dependency and is fast enough by a wide margin: 84 ms for 50 MB
 * on the reference machine, against a 60 s budget for indexing a 1M-LOC repo.
 * Adding a WASM or native hashing dependency to save ~50 ms would work against
 * the no-native-dependency property established in ADR-001. See ADR-003.
 */
const ALGORITHM = "blake2b512";

/** Content id: the truncated hex digest of the content. */
export type ContentId = string;

export const hashContent = (content: Buffer | string): ContentId =>
  createHash(ALGORITHM)
    .update(typeof content === "string" ? Buffer.from(content, "utf8") : content)
    .digest("hex")
    .slice(0, DIGEST_LENGTH);

export interface CacheOptions {
  /** Directory root, conventionally `<repo>/.agent/cache`. */
  readonly root: string;
}

export class ContentCache {
  private readonly root: string;
  /** Read-through memo, so `expand` in the same session avoids disk. */
  private readonly memo = new Map<ContentId, Buffer>();

  constructor(options: CacheOptions) {
    this.root = options.root;
  }

  /**
   * Fans entries across two levels by digest prefix.
   *
   * A long session masks thousands of outputs, and directories with tens of
   * thousands of entries are slow to enumerate on every major filesystem.
   */
  private pathFor(id: ContentId): string {
    return join(this.root, id.slice(0, 2), id.slice(2, 4), id);
  }

  /** Stores content and returns its id. Storing twice is a no-op. */
  put(content: Buffer | string): ContentId {
    const buffer = typeof content === "string" ? Buffer.from(content, "utf8") : content;
    const id = hashContent(buffer);

    if (this.memo.has(id)) return id;
    this.memo.set(id, buffer);

    const target = this.pathFor(id);
    mkdirSync(dirname(target), { recursive: true });

    // Write to a temp file and rename. A crash mid-write would otherwise leave
    // a truncated entry under a hash that claims to describe the full content,
    // which is the one failure this cache must never have: `expand` would
    // return corrupt data while looking successful.
    const temp = `${target}.${process.pid}.tmp`;
    writeFileSync(temp, buffer);
    renameSync(temp, target);

    return id;
  }

  /** Retrieves content by id, or `undefined` if it is not cached. */
  get(id: ContentId): Buffer | undefined {
    const memoized = this.memo.get(id);
    if (memoized) return memoized;

    try {
      const buffer = readFileSync(this.pathFor(id));
      this.memo.set(id, buffer);
      return buffer;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  /** Retrieves content decoded as UTF-8 text. */
  getText(id: ContentId): string | undefined {
    return this.get(id)?.toString("utf8");
  }

  has(id: ContentId): boolean {
    return this.get(id) !== undefined;
  }
}
