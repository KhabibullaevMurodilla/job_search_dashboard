/*
 * A minimal ZIP writer ("stored", no compression), so "download everything"
 * works in every browser without a library. Text files only in practice, so
 * compression would save little and cost a dependency.
 *
 * build([{ path, content }]) -> Uint8Array. Paths are written as given
 * (UTF-8, flag bit 11 set); the caller is responsible for them being
 * relative and safe, which applications.folderPlan() guarantees.
 */
(function (root) {
  "use strict";

  const TABLE = (function () {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(bytes) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) c = TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  function dosDateTime(d) {
    const y = Math.max(1980, d.getFullYear());
    return {
      time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
      date: ((y - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
    };
  }

  function build(files, when) {
    const enc = new TextEncoder();
    const dt = dosDateTime(when || new Date());
    const chunks = [];
    const central = [];
    let offset = 0;

    const push = (u8) => { chunks.push(u8); offset += u8.length; };

    for (const f of files) {
      const name = enc.encode(f.path);
      const data = enc.encode(f.content);
      const crc = crc32(data);

      const lh = new DataView(new ArrayBuffer(30));
      lh.setUint32(0, 0x04034b50, true);
      lh.setUint16(4, 20, true);
      lh.setUint16(6, 0x0800, true);     // UTF-8 names
      lh.setUint16(8, 0, true);          // stored
      lh.setUint16(10, dt.time, true);
      lh.setUint16(12, dt.date, true);
      lh.setUint32(14, crc, true);
      lh.setUint32(18, data.length, true);
      lh.setUint32(22, data.length, true);
      lh.setUint16(26, name.length, true);
      lh.setUint16(28, 0, true);

      const headerOffset = offset;
      push(new Uint8Array(lh.buffer));
      push(name);
      push(data);

      const ch = new DataView(new ArrayBuffer(46));
      ch.setUint32(0, 0x02014b50, true);
      ch.setUint16(4, 20, true);
      ch.setUint16(6, 20, true);
      ch.setUint16(8, 0x0800, true);
      ch.setUint16(10, 0, true);
      ch.setUint16(12, dt.time, true);
      ch.setUint16(14, dt.date, true);
      ch.setUint32(16, crc, true);
      ch.setUint32(20, data.length, true);
      ch.setUint32(24, data.length, true);
      ch.setUint16(28, name.length, true);
      ch.setUint32(42, headerOffset, true);
      central.push(new Uint8Array(ch.buffer), name);
    }

    const cdStart = offset;
    for (const c of central) push(c);
    const cdSize = offset - cdStart;

    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, files.length, true);
    end.setUint16(10, files.length, true);
    end.setUint32(12, cdSize, true);
    end.setUint32(16, cdStart, true);
    push(new Uint8Array(end.buffer));

    const out = new Uint8Array(offset);
    let p = 0;
    for (const c of chunks) { out.set(c, p); p += c.length; }
    return out;
  }

  root.Zip = { build, crc32 };
  if (typeof module !== "undefined" && module.exports) module.exports = { Zip: root.Zip };
})(typeof self !== "undefined" ? self : this);
