// Input checks shared by the upload, notes, and assistant pages.
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_CHAT_WORDS = 250;
const MAX_NOTE_WORDS = 300;

// Count words separated by any whitespace. Blank text is 0 words.
function countWords(text) {
  const trimmed = String(text || "").trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
}

// Cut text down to at most `limit` words, keeping the original spacing of what remains.
function limitWords(text, limit) {
  const pattern = /\S+/g;
  let count = 0;
  let match;
  while ((match = pattern.exec(text))) {
    count += 1;
    if (count === limit) return text.slice(0, match.index + match[0].length);
  }
  return text;
}

// Read the first bytes of a file to find its real type, whatever its name says.
async function sniffFileType(file) {
  const bytes = new Uint8Array(await file.slice(0, 8).arrayBuffer());
  const startsWith = signature => signature.every((value, i) => bytes[i] === value);
  if (startsWith([0x25, 0x50, 0x44, 0x46])) return "application/pdf";
  if (startsWith([0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith([0x89, 0x50, 0x4e, 0x47])) return "image/png";
  return null;
}

// Returns { ok: true, mime } or { ok: false, message }.
async function validateFile(file) {
  if (!file) return { ok: false, message: "No file was selected." };
  if (!/\.(pdf|jpe?g|png)$/i.test(file.name)) {
    return { ok: false, message: "Please choose a PDF, JPG, or PNG file." };
  }
  if (file.size === 0) return { ok: false, message: "That file is empty." };
  if (file.size > MAX_FILE_BYTES) {
    return { ok: false, message: "That file is larger than 10 MB. Please choose a smaller file." };
  }
  const mime = await sniffFileType(file);
  if (!mime) {
    return { ok: false, message: "That file's contents are not a real PDF, JPG, or PNG." };
  }
  return { ok: true, mime };
}
