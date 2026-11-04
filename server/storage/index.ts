import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

/** Where uploaded files live; a relative STORAGE_DIR resolves against the working directory. */
export function storageRoot(env: Record<string, string | undefined> = process.env): string {
  return path.resolve(/*turbopackIgnore: true*/ env.STORAGE_DIR || "storage");
}

export interface FileStorage {
  /** Saves bytes under the tenant's folder and returns the storage path. */
  save(tenantId: string, filename: string, bytes: Uint8Array): Promise<string>;
  read(storagePath: string): Promise<Uint8Array>;
  /** Deletes a stored file; a missing file is not an error. */
  remove(storagePath: string): Promise<void>;
}

export function createFileStorage(root: string = storageRoot()): FileStorage {
  function resolve(storagePath: string): string {
    const full = path.resolve(/*turbopackIgnore: true*/ root, storagePath);
    if (!full.startsWith(path.resolve(/*turbopackIgnore: true*/ root) + path.sep)) {
      throw new Error("Storage path escapes the storage root");
    }
    return full;
  }

  return {
    async save(tenantId, filename, bytes) {
      const ext = path.extname(filename).toLowerCase().replace(/[^a-z0-9.]/g, "");
      const storagePath = `${tenantId}/${randomUUID()}${ext}`;
      const full = resolve(storagePath);
      await mkdir(/*turbopackIgnore: true*/ path.dirname(full), { recursive: true });
      await writeFile(/*turbopackIgnore: true*/ full, bytes);
      return storagePath;
    },
    async read(storagePath) {
      return new Uint8Array(await readFile(/*turbopackIgnore: true*/ resolve(storagePath)));
    },
    async remove(storagePath) {
      await rm(/*turbopackIgnore: true*/ resolve(storagePath), { force: true });
    },
  };
}
