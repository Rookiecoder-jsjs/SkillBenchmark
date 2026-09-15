import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { existsSync, mkdirSync, renameSync, writeFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { sha256 } from "./hash.ts";

export class ObjectStore {
  readonly root: string;
  constructor(root: string) { this.root = root; }

  private pathFor(digest: string): string {
    if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error(`invalid object digest: ${digest}`);
    return join(this.root, digest.slice(0, 2), digest.slice(2));
  }

  async put(value: string | Uint8Array): Promise<{ digest: string; size: number; path: string }> {
    const bytes = typeof value === "string" ? Buffer.from(value) : Buffer.from(value);
    const digest = sha256(bytes);
    const path = this.pathFor(digest);
    if (!existsSync(path)) {
      await mkdir(dirname(path), { recursive: true });
      const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
      await writeFile(temporary, bytes, { flag: "wx" });
      await rename(temporary, path).catch(async (error) => {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") return;
        throw error;
      });
    }
    return { digest, size: bytes.byteLength, path };
  }

  putSync(value: string | Uint8Array): { digest: string; size: number; path: string } {
    const bytes = typeof value === "string" ? Buffer.from(value) : Buffer.from(value);
    const digest = sha256(bytes);
    const path = this.pathFor(digest);
    if (!existsSync(path)) {
      mkdirSync(dirname(path), { recursive: true });
      const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
      writeFileSync(temporary, bytes, { flag: "wx" });
      try { renameSync(temporary, path); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
    return { digest, size: bytes.byteLength, path };
  }

  async get(digest: string): Promise<Buffer> {
    const bytes = await readFile(this.pathFor(digest));
    if (sha256(bytes) !== digest) throw new Error(`object integrity check failed: ${digest}`);
    return bytes;
  }

  getSync(digest: string): Buffer {
    const bytes = readFileSync(this.pathFor(digest));
    if (sha256(bytes) !== digest) throw new Error(`object integrity check failed: ${digest}`);
    return bytes;
  }

  async has(digest: string): Promise<boolean> { return existsSync(this.pathFor(digest)); }
}
