import * as fse from "fs-extra";
import * as os from "os";
import * as path from "path";
import {
  withFileWriteLock,
  writeFileAtomic,
  writeJsonAtomic,
} from "./AtomicFile";

// The atomic writer imports its own namespace of fs-extra: mocking the
// module (rather than spying on the imported copy) lets the rename failure
// reach the implementation.
jest.mock("fs-extra", () => {
  const actual = jest.requireActual("fs-extra");
  return {
    ...actual,
    rename: jest.fn((...args: unknown[]) =>
      (actual.rename as (...inputs: unknown[]) => unknown)(...args),
    ),
  };
});

describe("AtomicFile", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fse.mkdtemp(path.join(os.tmpdir(), "atomic-file-spec-"));
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await fse.remove(tmpDir);
  });

  it("keeps the JSON valid under concurrent writes and leaves no temp file", async () => {
    const filePath = path.join(tmpDir, "state.json");
    await Promise.all(
      Array.from({ length: 30 }, (_, index) =>
        writeJsonAtomic(filePath, { counter: index }),
      ),
    );

    const content = await fse.readJson(filePath);
    expect(typeof content.counter).toBe("number");
    const leftovers = (await fse.readdir(tmpDir)).filter((entry) =>
      entry.includes(".tmp"),
    );
    expect(leftovers).toEqual([]);
  });

  it("serializes the operations sharing a file path", async () => {
    const filePath = path.join(tmpDir, "state.json");
    const events: string[] = [];

    const first = withFileWriteLock(filePath, async () => {
      events.push("first-start");
      await new Promise((resolve) => setTimeout(resolve, 20));
      events.push("first-end");
    });
    const second = withFileWriteLock(filePath, async () => {
      events.push("second");
    });
    await Promise.all([first, second]);

    expect(events).toEqual(["first-start", "first-end", "second"]);
  });

  it("removes the temp file when the rename fails", async () => {
    const filePath = path.join(tmpDir, "state.bin");
    const renameMock = fse.rename as unknown as jest.Mock;
    renameMock.mockRejectedValueOnce(new Error("boom"));

    await expect(writeFileAtomic(filePath, "data")).rejects.toThrow("boom");

    expect(await fse.pathExists(filePath)).toBe(false);
    const leftovers = (await fse.readdir(tmpDir)).filter((entry) =>
      entry.includes(".tmp"),
    );
    expect(leftovers).toEqual([]);
  });
});
