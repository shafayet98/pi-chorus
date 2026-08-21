import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Content-addressed blob store. Payloads are hashed and stored once.
 * Deduplication means identical tool outputs, repeated messages, etc. are stored once.
 * Diffing two turns' context becomes diffing two hash lists.
 */
export class ContentStore {
	private readonly dir: string;

	constructor(baseDir: string) {
		this.dir = join(baseDir, "blobs");
		if (!existsSync(this.dir)) {
			mkdirSync(this.dir, { recursive: true });
		}
	}

	/** Store a payload, return its content hash. */
	put(data: string | Buffer): string {
		const buf = typeof data === "string" ? Buffer.from(data, "utf-8") : data;
		const hash = createHash("sha256").update(buf).digest("hex");
		const path = this.blobPath(hash);
		if (!existsSync(path)) {
			writeFileSync(path, buf);
		}
		return hash;
	}

	/** Retrieve a payload by its content hash. Returns null if not found. */
	get(hash: string): Buffer | null {
		const path = this.blobPath(hash);
		if (!existsSync(path)) {
			return null;
		}
		return readFileSync(path);
	}

	/** Check whether a blob exists. */
	has(hash: string): boolean {
		return existsSync(this.blobPath(hash));
	}

	private blobPath(hash: string): string {
		// Two-level directory structure to avoid too many files in one dir
		const prefix = hash.slice(0, 2);
		const dir = join(this.dir, prefix);
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}
		return join(dir, hash);
	}
}
