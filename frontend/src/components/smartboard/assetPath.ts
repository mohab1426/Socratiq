// Excalidraw loads its fonts (including the hand-drawn Excalifont) from esm.sh unless told otherwise. A school product must not depend on a
// third-party CDN at runtime, and fallback fonts would change text measurements, so fonts are self-hosted (see scripts/copy-excalidraw-assets.mjs).
// This module must be imported BEFORE "@excalidraw/excalidraw" (ES module evaluation order guarantees it).
;(window as unknown as { EXCALIDRAW_ASSET_PATH?: string }).EXCALIDRAW_ASSET_PATH = "/excalidraw-assets/"
export {}
