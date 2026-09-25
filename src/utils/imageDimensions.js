// Read an image's width and height from its header, without decoding it.
// Decoding is exactly what a decompression bomb (a small file that expands to
// billions of pixels) attacks, so sizes must be known before OCR.
//
// The format is recognised from the bytes, not the declared MIME type: the
// OCR engine also decodes by content, so a PNG labelled "image/jpeg" must be
// measured as a PNG. Returns null for anything that isn't a readable PNG or JPEG.

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// JPEG start-of-frame markers carry the image size (SOF0-SOF15 except DHT,
// JPG and DAC, which share the range but aren't frame headers).
const JPEG_SOF_MARKERS = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
// Markers with no length field.
const JPEG_STANDALONE_MARKERS = new Set([0x01, 0xd0, 0xd1, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9]);

function readPng(buffer) {
    // Signature (8) + IHDR length (4) + "IHDR" (4) + width (4) + height (4)
    if (buffer.length < 24 || buffer.toString("ascii", 12, 16) !== "IHDR") return null;
    return { format: "png", width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

function readJpeg(buffer) {
    let offset = 2; // after the FF D8 start-of-image marker

    while (offset + 4 <= buffer.length) {
        if (buffer[offset] !== 0xff) return null;
        const marker = buffer[offset + 1];

        if (marker === 0xff) { // fill byte before a marker
            offset += 1;
            continue;
        }
        if (JPEG_STANDALONE_MARKERS.has(marker)) {
            offset += 2;
            continue;
        }

        const segmentLength = buffer.readUInt16BE(offset + 2);
        if (segmentLength < 2) return null;

        if (JPEG_SOF_MARKERS.has(marker)) {
            // length (2) + precision (1) + height (2) + width (2)
            if (offset + 9 > buffer.length) return null;
            return { format: "jpeg", height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
        }
        if (marker === 0xda) return null; // image data started without a frame header

        offset += 2 + segmentLength;
    }

    return null;
}

export function readImageDimensions(buffer) {
    if (!Buffer.isBuffer(buffer)) return null;

    let dimensions = null;
    if (buffer.length >= 8 && buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
        dimensions = readPng(buffer);
    } else if (buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8) {
        dimensions = readJpeg(buffer);
    }

    return dimensions && dimensions.width > 0 && dimensions.height > 0 ? dimensions : null;
}
