import fs from 'node:fs';
import { wholeUtf8, type OutputRead } from '../shared/output-tail';

/** Most of a background command's output one read returns: its tail, or what it added since the last read. */
export const OUTPUT_READ_BYTES = 65_536;

/**
 * A file's text from byte `known` on, as far as it has whole characters: nothing when it hasn't grown, and its last
 * `maxBytes` from a whole line when there's no `known`, when it shrank (written again), or when it grew by more.
 */
export async function readOutputFrom(file: string, known: number | undefined, maxBytes = OUTPUT_READ_BYTES): Promise<OutputRead> {
  const fh = await fs.promises.open(file, 'r');
  try {
    const { size } = await fh.stat();
    if (known === size) return { end: size, from: size };
    const follows = known !== undefined && known < size && size - known <= maxBytes;
    const start = follows ? known : Math.max(0, size - maxBytes);
    const buf = Buffer.alloc(size - start);
    const { bytesRead } = await fh.read(buf, 0, buf.length, start);
    let bytes = buf.subarray(0, bytesRead);
    let from = start;
    if (!follows && start > 0) {
      // A tail starts at its first whole line.
      const nl = bytes.indexOf(0x0a);
      if (nl !== -1) {
        bytes = bytes.subarray(nl + 1);
        from += nl + 1;
      }
    }
    const whole = wholeUtf8(bytes);
    return {
      end: from + whole,
      from,
      text: bytes.subarray(0, whole).toString('utf8'),
    };
  } finally {
    await fh.close();
  }
}
