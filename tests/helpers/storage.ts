import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll } from "vitest";
import { createFileStorage, type FileStorage } from "@/server/storage";

/** File storage in a temporary folder that is removed after the current test file. */
export async function tempStorage(): Promise<FileStorage> {
  const root = await mkdtemp(path.join(tmpdir(), "storage-test-"));
  afterAll(() => rm(root, { recursive: true, force: true }));
  return createFileStorage(root);
}
