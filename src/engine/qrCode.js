/**
 * Zero-Dependency ISO/IEC 18004 QR Code Generator (Byte Mode, Error Correction Level M).
 * Supports Versions 1–10 (up to 213 UTF-8 bytes) — ideal for LAN/HTTPS auto-join URLs.
 * Returns a boolean 2D matrix (`true` = dark module, `false` = light module) for crisp SVG rendering.
 */

// Error Correction Level M parameters per Version 1..10:
// [totalCodewords, ecCodewordsPerBlock, group1Blocks, group1DataCW, group2Blocks, group2DataCW]
const VERSION_M_SPECS = [
  null,
  [26, 10, 1, 16, 0, 0], // V1  (21x21, max 14 bytes)
  [44, 16, 1, 28, 0, 0], // V2  (25x25, max 26 bytes)
  [70, 26, 1, 44, 0, 0], // V3  (29x29, max 42 bytes)
  [100, 18, 2, 32, 0, 0], // V4  (33x33, max 62 bytes)
  [134, 24, 2, 43, 0, 0], // V5  (37x37, max 84 bytes)
  [172, 16, 4, 27, 0, 0], // V6  (41x41, max 106 bytes)
  [196, 18, 4, 31, 0, 0], // V7  (45x45, max 122 bytes)
  [242, 22, 2, 38, 2, 39], // V8  (49x49, max 152 bytes)
  [292, 22, 3, 36, 2, 37], // V9  (53x53, max 180 bytes)
  [346, 26, 4, 43, 1, 44], // V10 (57x57, max 213 bytes)
];

const ALIGNMENT_POSITIONS = [
  null,
  [],
  [6, 18],
  [6, 22],
  [6, 26],
  [6, 30],
  [6, 34],
  [6, 22, 38],
  [6, 24, 42],
  [6, 26, 46],
  [6, 28, 50],
];

// GF(256) lookup tables with primitive polynomial 0x11d (x^8 + x^4 + x^3 + x^2 + 1)
const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) {
    GF_EXP[i] = GF_EXP[i - 255];
  }
}

function gfMul(a, b) {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

function rsGeneratorPoly(degree) {
  let poly = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array(poly.length + 1).fill(0);
    const factor = GF_EXP[i];
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMul(poly[j], factor);
    }
    poly = next;
  }
  return poly;
}

function rsComputeRemainder(data, ecCount) {
  const gen = rsGeneratorPoly(ecCount);
  const res = new Uint8Array(ecCount);
  for (let i = 0; i < data.length; i++) {
    const factor = data[i] ^ res[0];
    for (let j = 0; j < ecCount - 1; j++) {
      res[j] = res[j + 1] ^ gfMul(gen[j + 1], factor);
    }
    res[ecCount - 1] = gfMul(gen[ecCount], factor);
  }
  return res;
}

function utf8Bytes(text) {
  if (typeof TextEncoder !== 'undefined') {
    return Array.from(new TextEncoder().encode(String(text || '')));
  }
  const str = unescape(encodeURIComponent(String(text || '')));
  const out = [];
  for (let i = 0; i < str.length; i++) out.push(str.charCodeAt(i) & 0xff);
  return out;
}

function selectVersion(byteLen) {
  for (let v = 1; v < VERSION_M_SPECS.length; v++) {
    const [, , g1, d1, g2, d2] = VERSION_M_SPECS[v];
    const totalDataCodewords = g1 * d1 + g2 * d2;
    const countBits = v <= 9 ? 8 : 16;
    const neededBits = 4 + countBits + byteLen * 8;
    if (neededBits <= totalDataCodewords * 8) {
      return v;
    }
  }
  throw new Error('QR payload exceeds supported Version 10 capacity (213 bytes)');
}

function encodeDataCodewords(bytes, version) {
  const [, , g1, d1, g2, d2] = VERSION_M_SPECS[version];
  const totalDataCW = g1 * d1 + g2 * d2;
  const capacityBits = totalDataCW * 8;
  const bits = [];

  const pushBits = (val, len) => {
    for (let i = len - 1; i >= 0; i--) {
      bits.push((val >>> i) & 1);
    }
  };

  // Byte mode indicator (0100)
  pushBits(0b0100, 4);
  // Character count indicator
  pushBits(bytes.length, version <= 9 ? 8 : 16);
  // Payload bytes
  for (const b of bytes) pushBits(b, 8);
  // Terminator (up to 4 zero bits)
  const termLen = Math.min(4, capacityBits - bits.length);
  pushBits(0, termLen);
  // Pad to byte boundary
  while (bits.length % 8 !== 0) bits.push(0);

  const codewords = [];
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j++) byte = (byte << 1) | bits[i + j];
    codewords.push(byte);
  }
  const padBytes = [0xec, 0x11];
  let padIdx = 0;
  while (codewords.length < totalDataCW) {
    codewords.push(padBytes[padIdx % 2]);
    padIdx += 1;
  }
  return codewords;
}

function buildFinalCodewords(dataCW, version) {
  const [, ecPerBlock, g1, d1, g2, d2] = VERSION_M_SPECS[version];
  const dataBlocks = [];
  const ecBlocks = [];
  let offset = 0;

  for (let i = 0; i < g1; i++) {
    const blk = dataCW.slice(offset, offset + d1);
    offset += d1;
    dataBlocks.push(blk);
    ecBlocks.push(Array.from(rsComputeRemainder(blk, ecPerBlock)));
  }
  for (let i = 0; i < g2; i++) {
    const blk = dataCW.slice(offset, offset + d2);
    offset += d2;
    dataBlocks.push(blk);
    ecBlocks.push(Array.from(rsComputeRemainder(blk, ecPerBlock)));
  }

  const finalCW = [];
  const maxDataLen = Math.max(d1, d2);
  for (let col = 0; col < maxDataLen; col++) {
    for (const blk of dataBlocks) {
      if (col < blk.length) finalCW.push(blk[col]);
    }
  }
  for (let col = 0; col < ecPerBlock; col++) {
    for (const blk of ecBlocks) {
      finalCW.push(blk[col]);
    }
  }
  return finalCW;
}

function computeFormatBits(maskPattern) {
  // Error Correction Level M = 00
  const data = (0b00 << 3) | (maskPattern & 7);
  let rem = data << 10;
  const poly = 0x537;
  for (let i = 14; i >= 10; i--) {
    if ((rem >>> i) & 1) rem ^= poly << (i - 10);
  }
  return ((data << 10) | rem) ^ 0x5412;
}

function computeVersionBits(version) {
  let rem = version << 12;
  const poly = 0x1f25;
  for (let i = 17; i >= 12; i--) {
    if ((rem >>> i) & 1) rem ^= poly << (i - 12);
  }
  return (version << 12) | rem;
}

function buildBaseMatrix(version) {
  const size = version * 4 + 17;
  const modules = Array.from({ length: size }, () => new Array(size).fill(false));
  const isFunction = Array.from({ length: size }, () => new Array(size).fill(false));

  const setFunc = (r, c, dark) => {
    if (r < 0 || c < 0 || r >= size || c >= size) return;
    modules[r][c] = Boolean(dark);
    isFunction[r][c] = true;
  };

  // 1. Three 7x7 finder patterns + 1px light separator
  const drawFinder = (topR, topC) => {
    for (let dr = -1; dr <= 7; dr++) {
      for (let dc = -1; dc <= 7; dc++) {
        const r = topR + dr;
        const c = topC + dc;
        if (r < 0 || c < 0 || r >= size || c >= size) continue;
        const inOuter = dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6;
        const onBorder = dr === 0 || dr === 6 || dc === 0 || dc === 6;
        const inCenter = dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4;
        setFunc(r, c, inOuter && (onBorder || inCenter));
      }
    }
  };
  drawFinder(0, 0);
  drawFinder(0, size - 7);
  drawFinder(size - 7, 0);

  // 2. Timing patterns
  for (let i = 8; i < size - 8; i++) {
    setFunc(6, i, i % 2 === 0);
    setFunc(i, 6, i % 2 === 0);
  }

  // 3. Alignment patterns (Version >= 2)
  const alignCoords = ALIGNMENT_POSITIONS[version] || [];
  for (const rCenter of alignCoords) {
    for (const cCenter of alignCoords) {
      if (isFunction[rCenter][cCenter]) continue;
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          const dist = Math.max(Math.abs(dr), Math.abs(dc));
          setFunc(rCenter + dr, cCenter + dc, dist !== 1);
        }
      }
    }
  }

  // 4. Reserve format information areas + dark module
  for (let i = 0; i <= 8; i++) {
    if (!isFunction[8][i]) setFunc(8, i, false);
    if (!isFunction[i][8]) setFunc(i, 8, false);
  }
  for (let i = size - 8; i < size; i++) {
    setFunc(8, i, false);
    setFunc(i, 8, false);
  }
  setFunc(size - 8, 8, true); // Mandatory dark module

  // 5. Version information (Version >= 7)
  if (version >= 7) {
    const vBits = computeVersionBits(version);
    for (let i = 0; i < 18; i++) {
      const bit = Boolean((vBits >>> i) & 1);
      const r = Math.floor(i / 3);
      const c = size - 11 + (i % 3);
      setFunc(r, c, bit);
      setFunc(c, r, bit);
    }
  }

  return { size, modules, isFunction };
}

function writeFormatInfo(modules, size, maskPattern) {
  const bits = computeFormatBits(maskPattern);
  const bitAt = (i) => Boolean((bits >>> i) & 1);

  // Around top-left finder
  for (let i = 0; i <= 5; i++) modules[8][i] = bitAt(14 - i);
  modules[8][7] = bitAt(8);
  modules[8][8] = bitAt(7);
  modules[7][8] = bitAt(6);
  for (let i = 0; i <= 5; i++) modules[5 - i][8] = bitAt(5 - i);

  // Split across bottom-left and top-right finders
  for (let i = 0; i <= 6; i++) modules[size - 1 - i][8] = bitAt(14 - i);
  for (let i = 0; i <= 7; i++) modules[8][size - 8 + i] = bitAt(7 - i);
}

function maskCondition(maskPattern, r, c) {
  switch (maskPattern) {
    case 0:
      return (r + c) % 2 === 0;
    case 1:
      return r % 2 === 0;
    case 2:
      return c % 3 === 0;
    case 3:
      return (r + c) % 3 === 0;
    case 4:
      return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0;
    case 5:
      return ((r * c) % 2) + ((r * c) % 3) === 0;
    case 6:
      return (((r * c) % 2) + ((r * c) % 3)) % 2 === 0;
    case 7:
      return (((r + c) % 2) + ((r * c) % 3)) % 2 === 0;
    default:
      return false;
  }
}

function scorePenalty(modules, size) {
  let penalty = 0;
  // Rule 1: Runs of >= 5 same-color modules in rows & columns
  for (let r = 0; r < size; r++) {
    let runColor = modules[r][0];
    let runLen = 1;
    for (let c = 1; c < size; c++) {
      if (modules[r][c] === runColor) {
        runLen += 1;
        if (runLen === 5) penalty += 3;
        else if (runLen > 5) penalty += 1;
      } else {
        runColor = modules[r][c];
        runLen = 1;
      }
    }
  }
  for (let c = 0; c < size; c++) {
    let runColor = modules[0][c];
    let runLen = 1;
    for (let r = 1; r < size; r++) {
      if (modules[r][c] === runColor) {
        runLen += 1;
        if (runLen === 5) penalty += 3;
        else if (runLen > 5) penalty += 1;
      } else {
        runColor = modules[r][c];
        runLen = 1;
      }
    }
  }
  // Rule 2: 2x2 same-color blocks
  for (let r = 0; r < size - 1; r++) {
    for (let c = 0; c < size - 1; c++) {
      const v = modules[r][c];
      if (modules[r][c + 1] === v && modules[r + 1][c] === v && modules[r + 1][c + 1] === v) {
        penalty += 3;
      }
    }
  }
  // Rule 4: Dark/light balance
  let darkCount = 0;
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (modules[r][c]) darkCount += 1;
    }
  }
  const pct = (darkCount * 100) / (size * size);
  const k = Math.floor(Math.abs(pct - 50) / 5);
  penalty += k * 10;
  return penalty;
}

/**
 * Generates a scannable QR Code boolean matrix (`size x size`) for `text`.
 */
export function generateQrMatrix(text) {
  const bytes = utf8Bytes(text);
  const version = selectVersion(bytes.length);
  const dataCW = encodeDataCodewords(bytes, version);
  const finalCW = buildFinalCodewords(dataCW, version);

  const { size, modules: baseModules, isFunction } = buildBaseMatrix(version);

  // Place data bits in zigzag column pairs (right-to-left, skipping col 6)
  let bitIdx = 0;
  const totalBits = finalCW.length * 8;
  let upward = true;
  for (let rightCol = size - 1; rightCol >= 1; rightCol -= 2) {
    if (rightCol === 6) rightCol = 5;
    for (let step = 0; step < size; step++) {
      const r = upward ? size - 1 - step : step;
      for (let offset = 0; offset < 2; offset++) {
        const c = rightCol - offset;
        if (isFunction[r][c]) continue;
        let bit = false;
        if (bitIdx < totalBits) {
          bit = Boolean((finalCW[bitIdx >>> 3] >>> (7 - (bitIdx & 7))) & 1);
          bitIdx += 1;
        }
        baseModules[r][c] = bit;
      }
    }
    upward = !upward;
  }

  // Evaluate all 8 masks and pick the lowest-penalty pattern
  let bestModules = null;
  let bestPenalty = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    const candidate = baseModules.map((row, r) =>
      row.map((val, c) => (!isFunction[r][c] && maskCondition(mask, r, c) ? !val : val))
    );
    writeFormatInfo(candidate, size, mask);
    const p = scorePenalty(candidate, size);
    if (p < bestPenalty) {
      bestPenalty = p;
      bestModules = candidate;
    }
  }

  return { size, version, modules: bestModules };
}

/**
 * Converts a QR matrix into an optimized single-path SVG `d` string for crisp rendering.
 */
export function qrMatrixToSvgPath(modules) {
  let d = '';
  for (let r = 0; r < modules.length; r++) {
    const row = modules[r];
    for (let c = 0; c < row.length; c++) {
      if (row[c]) {
        d += `M${c},${r}h1v1h-1z`;
      }
    }
  }
  return d;
}
