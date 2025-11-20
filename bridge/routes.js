export default function routes(app, spawnBackend, getParams, getRecent) {
  app.get("/params", (_req, res) => res.json(getParams()));

  app.post("/restart", (req, res) => {
    const {
      bufSize,
      producers,
      consumers,
      runSec,
      seed,
      itemTypes,
      speedMs,
    } = req.body || {};

    let itemsStr = "";
    if (Array.isArray(itemTypes)) {
      itemsStr = itemTypes.map(s => String(s).trim()).filter(Boolean).join(",");
    } else if (typeof itemTypes === "string") {
      itemsStr = itemTypes.split(",").map(s => s.trim()).filter(Boolean).join(",");
    }

    if (itemsStr) globalThis._ITEM_TYPES = itemsStr.split(",");

    spawnBackend({
      bufSize,
      producers,
      consumers,
      runSec,
      seed,
      itemTypes: itemsStr,
      speedMs,
    });

    res.json({ ok: true });
  });

  app.get("/dump", (_req, res) => res.json(getRecent()));
}