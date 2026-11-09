import { open } from "node:fs/promises";

/** Lee un fichero por trozos sin cargarlo entero en memoria. */
export async function* readChunks(
  filePath: string,
  chunkSize: number
): AsyncGenerator<Buffer> {
  if (chunkSize <= 0) throw new Error("chunkSize debe ser mayor que 0");

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
