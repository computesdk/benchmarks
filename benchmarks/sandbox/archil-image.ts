// node:24-trixie rather than bookworm: bookworm's coreutils hash in software,
// trixie's through OpenSSL (SHA-NI), which the CPU bench's `sha256sum` measures.
export const ARCHIL_BASE_IMAGE = 'node:24-trixie';
