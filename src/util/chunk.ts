import { open } from "node:fs/promises";

/** Reads a file in chunks without loading it entirely into memory. */
export async function* readChunks(
  filePath: string,
  chunkSize: number
): AsyncGenerator<Buffer> {
  if (chunkSize <= 0) throw new Error("chunkSize must be greater than 0");

  const handle = await open(filePath, "r");
  try {
    let position = 0;
    while (true) {
      const buffer = Buffer.alloc(chunkSize);
      const { bytesRead } = await handle.read(buffer, 0, chunkSize, position);
      if (bytesRead === 0) return;
      yield buffer.subarray(0, bytesRead);
      position += bytesRead;
    }
  } finally {
    await handle.close();
  }
}
