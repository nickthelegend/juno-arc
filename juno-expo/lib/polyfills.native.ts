/**
 * What viem needs that Hermes does not have, installed before anything else
 * on iOS and Android. The web build resolves `polyfills.ts`.
 *
 * `crypto.getRandomValues`: viem's `generatePrivateKey` draws randomness from
 * it. `react-native-get-random-values` must come first: `@noble/hashes` reads
 * `globalThis.crypto` once, when it is first imported, and keeps what it found.
 */

import "react-native-get-random-values";
