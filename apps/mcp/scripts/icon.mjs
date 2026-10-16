// genera bundle/icon.png (256x256): círculo violeta VentaPlay con globo de chat turquesa
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
const N = 256,
  px = Buffer.alloc(N * N * 4);
const mix = (a, b, t) => Math.round(a + (b - a) * t);
for (let y = 0; y < N; y++)
  for (let x = 0; x < N; x++) {
    const i = (y * N + x) * 4,
      dx = x - 127.5,
      dy = y - 127.5,
      r = Math.hypot(dx, dy);
    let c = [0, 0, 0, 0];
    if (r < 124) {
      const t = (x + y) / (2 * N);
      c = [mix(0x45, 0x8c, t), mix(0x06, 0x00, t), mix(0x93, 0xff, t), 255];
    }
    // globo: elipse + cola
    const ex = (x - 128) / 70,
      ey = (y - 118) / 56;
    const tail =
      x > 70 &&
      x < 112 &&
      y > 150 &&
      y < 196 &&
      ((x - 70) * 46) / 42 > y - 150 - 4 &&
      y - 150 < (112 - x) * 1.1 + 6;
    if (ex * ex + ey * ey < 1 || tail) c = [255, 255, 255, 255];
    // tres puntos turquesa
    for (const cx of [96, 128, 160])
      if (Math.hypot(x - cx, y - 118) < 11) c = [0x08, 0xc8, 0xa7, 255];
    px.set(c, i);
  }
const raw = Buffer.alloc(N * (N * 4 + 1));
for (let y = 0; y < N; y++) {
  raw[y * (N * 4 + 1)] = 0;
  px.copy(raw, y * (N * 4 + 1) + 1, y * N * 4, (y + 1) * N * 4);
}
const crc = (b) => {
  let c,
    t = [];
  for (let n = 0; n < 256; n++) {
    c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  let x = 0xffffffff;
  for (const v of b) x = t[(x ^ v) & 255] ^ (x >>> 8);
  return (x ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const l = Buffer.alloc(4);
  l.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const c = Buffer.alloc(4);
  c.writeUInt32BE(crc(td));
  return Buffer.concat([l, td, c]);
};
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(N, 0);
ihdr.writeUInt32BE(N, 4);
ihdr[8] = 8;
ihdr[9] = 6;
writeFileSync(
  new URL('../bundle/icon.png', import.meta.url),
  Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]),
);
