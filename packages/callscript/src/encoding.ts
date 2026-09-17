const BASE64_ALPHABET =
	"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const BASE64URL_ALPHABET =
	"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

const UTF8_ENCODER = new TextEncoder();
const UTF8_DECODER = new TextDecoder();

/** Return the number of bytes a string occupies when encoded as UTF-8. */
export function utf8ByteLength(value: string): number {
	return UTF8_ENCODER.encode(value).byteLength;
}

/** Encode a UTF-8 string as standard or unpadded URL-safe Base64. */
export function encodeBase64(value: string, urlSafe = false): string {
	const bytes = UTF8_ENCODER.encode(value);
	const alphabet = urlSafe ? BASE64URL_ALPHABET : BASE64_ALPHABET;
	let encoded = "";

	for (let i = 0; i < bytes.length; i += 3) {
		const first = bytes[i]!;
		const second = bytes[i + 1];
		const third = bytes[i + 2];

		encoded += alphabet[first >> 2];
		encoded += alphabet[((first & 0x03) << 4) | ((second ?? 0) >> 4)];
		encoded +=
			second === undefined
				? "="
				: alphabet[((second & 0x0f) << 2) | ((third ?? 0) >> 6)];
		encoded += third === undefined ? "=" : alphabet[third & 0x3f];
	}

	return urlSafe ? encoded.replace(/=+$/, "") : encoded;
}

/** Decode standard or URL-safe Base64 into a UTF-8 string. */
export function decodeBase64(value: string): string {
	const bytes: number[] = [];
	let accumulator = 0;
	let bits = 0;

	for (const char of value) {
		if (char === "=") break;
		const digit = base64Digit(char.charCodeAt(0));
		// Match Buffer's forgiving decoder: whitespace and unknown characters
		// are ignored, and either Base64 alphabet is accepted.
		if (digit < 0) continue;

		accumulator = (accumulator << 6) | digit;
		bits += 6;
		if (bits >= 8) {
			bits -= 8;
			bytes.push((accumulator >>> bits) & 0xff);
			accumulator &= (1 << bits) - 1;
		}
	}

	return UTF8_DECODER.decode(new Uint8Array(bytes));
}

function base64Digit(code: number): number {
	if (code >= 65 && code <= 90) return code - 65;
	if (code >= 97 && code <= 122) return code - 71;
	if (code >= 48 && code <= 57) return code + 4;
	if (code === 43 || code === 45) return 62;
	if (code === 47 || code === 95) return 63;
	return -1;
}
