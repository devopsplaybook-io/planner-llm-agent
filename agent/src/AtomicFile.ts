import * as fse from "fs-extra";
import * as path from "path";

// Serializes the writes of one file path: operations sharing a path chain on
// each other, so a read-modify-write or a pair of concurrent writers can
// never interleave. The chain is dropped once it becomes the tail and
// settles.
const writeLocks = new Map<string, Promise<void>>();

export function withFileWriteLock<T>(
  filePath: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = writeLocks.get(filePath) ?? Promise.resolve();
  const result = previous.then(operation, operation);
  const release = result.then(
    () => undefined,
    () => undefined,
  );
  writeLocks.set(filePath, release);
  void release.then(() => {
    if (writeLocks.get(filePath) === release) {
      writeLocks.delete(filePath);
    }
  });
  return result;
}

// Atomic write through a temp file and a rename: a concurrent reader sees
// either the previous complete file or the new one, never a partial write.
export async function writeFileAtomic(
  filePath: string,
  data: string | Buffer,
): Promise<void> {
  await fse.ensureDir(path.dirname(filePath));
  const tempFile = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fse.writeFile(tempFile, data);
    await fse.rename(tempFile, filePath);
  } finally {
    // A failed rename leaves the temp file behind: remove it.
    await fse.remove(tempFile).catch(() => undefined);
  }
}

// JSON variant, always serialized per path through the write lock.
export async function writeJsonAtomic(
  filePath: string,
  value: unknown,
): Promise<void> {
  await withFileWriteLock(filePath, () =>
    writeFileAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`),
  );
}
