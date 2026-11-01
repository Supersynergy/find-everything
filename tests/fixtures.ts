export function wave(seconds: number, rate = 8000, channels = 1): Buffer {
  const bytes = Math.round(seconds * rate) * channels * 2;
  const b = Buffer.alloc(44 + bytes);
  b.write("RIFF"); b.writeUInt32LE(36 + bytes, 4); b.write("WAVEfmt ", 8);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(channels, 22);
  b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * channels * 2, 28);
  b.writeUInt16LE(channels * 2, 32); b.writeUInt16LE(16, 34);
  b.write("data", 36); b.writeUInt32LE(bytes, 40); return b;
}
