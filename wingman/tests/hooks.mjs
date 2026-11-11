export async function resolve(spec, ctx, next) {
  if (spec === "herdr") return { url: new URL("./herdr-shim.mjs", import.meta.url).href, shortCircuit: true };
  // Mod code's "fs/promises" is Herdr's, which has exists().
  if (spec === "fs/promises" && ctx.parentURL?.includes("/mods/wingman/")) return { url: new URL("./fs-shim.mjs", import.meta.url).href, shortCircuit: true };
  return next(spec, ctx);
}
