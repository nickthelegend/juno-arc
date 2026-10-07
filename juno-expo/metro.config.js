const { getDefaultConfig } = require("expo/metro-config");

/**
 * Metro, as Expo configures it. Nothing to override: the app's only chain
 * dependency is viem, which resolves cleanly on iOS, Android and the web.
 */
module.exports = getDefaultConfig(__dirname);
