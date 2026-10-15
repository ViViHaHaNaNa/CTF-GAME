// The ONE place the client learns where the game server is.
// Empty = same address the page came from (dev proxy on this laptop, or `npm start`).
// For a cloud move, set VITE_SIEGE_SERVER_URL in client/.env and rebuild. No other code changes.
export const SERVER_URL: string | undefined = import.meta.env.VITE_SIEGE_SERVER_URL || undefined;

/** Public path of the art pack (copied from PostApocalypse_AssetPack_v1.1.2 by TheLazyStone). */
export const ASSET_ROOT = '/game-assets/postapocalypse/';
