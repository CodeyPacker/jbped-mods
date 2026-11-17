export async function resolve(spec, ctx, next) {
  if (spec === "herdr") return { url: new URL("./herdr-shim.mjs", import.meta.url).href, shortCircuit: true };
  // Herdr's "fs/promises" is Node's here.
  if (spec === "fs/promises") return next("node:fs/promises", ctx);
  return next(spec, ctx);
}
