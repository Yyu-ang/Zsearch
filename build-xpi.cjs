// Create XPI with forward slashes (required by Zotero/Firefox)
const fs = require("fs");
const path = require("path");
const {
  createWriteStream,
} = require("fs");

// Simple ZIP/XPI creator using Node.js
// We'll use the zlib + crc32 to create a valid ZIP file

const buildDir = "D:\\library\\code\\Zsearch\\.scaffold\\build\\addon";
// Output to project root so user can install it manually from Zotero
const xpiPath = "D:\\library\\code\\Zsearch\\build\\zsearch.xpi";

// Ensure output directory exists
const outputDir = require("path").dirname(xpiPath);
if (!fs.existsSync(outputDir)) {
  fs.mkdirSync(outputDir, { recursive: true });
}

function getAllFiles(dir, base = dir) {
  const results = [];
  const items = fs.readdirSync(dir, { withFileTypes: true });
  for (const item of items) {
    const fullPath = path.join(dir, item.name);
    if (item.isDirectory()) {
      results.push(...getAllFiles(fullPath, base));
    } else {
      // Use forward slashes for ZIP paths
      const relPath = path.relative(base, fullPath).split(path.sep).join("/");
      results.push({ fullPath, zipPath: relPath });
    }
  }
  return results;
}

// CRC32 implementation
const crc32Table = [];
for (let i = 0; i < 256; i++) {
  let crc = i;
  for (let j = 0; j < 8; j++) {
    if (crc & 1) {
      crc = 0xedb88320 ^ (crc >>> 1);
    } else {
      crc = crc >>> 1;
    }
  }
  crc32Table[i] = crc >>> 0;
}

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = crc32Table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function writeZip(files, outputPath) {
  const buf = [];
  const centralDir = [];
  let offset = 0;

  for (const file of files) {
    const data = fs.readFileSync(file.fullPath);
    const crc = crc32(data);
    const nameBuf = Buffer.from(file.zipPath, "utf8");
    const compressed = data; // Store mode (no compression)

    // Local file header
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0); // signature
    localHeader.writeUInt16LE(20, 4); // version needed
    localHeader.writeUInt16LE(0, 6); // flags
    localHeader.writeUInt16LE(0, 8); // compression (store)
    localHeader.writeUInt16LE(0, 10); // mod time
    localHeader.writeUInt16LE(0, 12); // mod date
    localHeader.writeUInt32LE(crc, 14); // crc32
    localHeader.writeUInt32LE(data.length, 18); // compressed size
    localHeader.writeUInt32LE(data.length, 22); // uncompressed size
    localHeader.writeUInt16LE(nameBuf.length, 26); // filename length
    localHeader.writeUInt16LE(0, 28); // extra field length

    buf.push(localHeader);
    buf.push(nameBuf);
    buf.push(compressed);

    // Central directory header
    const cdHeader = Buffer.alloc(46);
    cdHeader.writeUInt32LE(0x02014b50, 0); // signature
    cdHeader.writeUInt16LE(20, 4); // version made by
    cdHeader.writeUInt16LE(20, 6); // version needed
    cdHeader.writeUInt16LE(0, 8); // flags
    cdHeader.writeUInt16LE(0, 10); // compression
    cdHeader.writeUInt16LE(0, 12); // mod time
    cdHeader.writeUInt16LE(0, 14); // mod date
    cdHeader.writeUInt32LE(crc, 16); // crc32
    cdHeader.writeUInt32LE(data.length, 20); // compressed size
    cdHeader.writeUInt32LE(data.length, 24); // uncompressed size
    cdHeader.writeUInt16LE(nameBuf.length, 28); // filename length
    cdHeader.writeUInt16LE(0, 30); // extra field length
    cdHeader.writeUInt16LE(0, 32); // comment length
    cdHeader.writeUInt16LE(0, 34); // disk number
    cdHeader.writeUInt16LE(0, 36); // internal attrs
    cdHeader.writeUInt32LE(0, 38); // external attrs
    cdHeader.writeUInt32LE(offset, 42); // offset of local header

    centralDir.push(cdHeader);
    centralDir.push(nameBuf);

    offset += localHeader.length + nameBuf.length + data.length;
  }

  // End of central directory
  const cdOffset = offset;
  const cdSize = centralDir.reduce((s, b) => s + b.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // signature
  eocd.writeUInt16LE(0, 4); // disk number
  eocd.writeUInt16LE(0, 6); // disk with CD
  eocd.writeUInt16LE(files.length, 8); // entries on this disk
  eocd.writeUInt16LE(files.length, 10); // total entries
  eocd.writeUInt32LE(cdSize, 12); // CD size
  eocd.writeUInt32LE(cdOffset, 16); // CD offset
  eocd.writeUInt16LE(0, 20); // comment length

  const allParts = [...buf, ...centralDir, eocd];
  const result = Buffer.concat(allParts);
  fs.writeFileSync(outputPath, result);
  return result.length;
}

const files = getAllFiles(buildDir);
console.log(`Packing ${files.length} files...`);
files.forEach((f) => console.log(`  ${f.zipPath}`));
const size = writeZip(files, xpiPath);
console.log(`XPI created: ${xpiPath} (${size} bytes)`);
