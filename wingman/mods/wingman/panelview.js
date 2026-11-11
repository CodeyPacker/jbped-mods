// Where a Wingman panel copy sits in Herdr's layout (layout()), and whether it's on screen. Pure.

/** The nodes from the layout's root down to the Wingman block for `view`, or null when there is none. */
export function viewPath(tree, view) {
  const path = [];
  const walk = (n) => {
    if (!n || typeof n !== "object") return false;
    path.push(n);
    if (n.content?.mod === "wingman" && n.content.props?.view === view) return true;
    for (const c of n.children ?? []) if (walk(c)) return true;
    path.pop(); return false;
  };
  return walk(tree) ? path : null;
}

/**
 * Whether the Wingman block for `view` is shown: no node on its path is hidden, and every stack on
 * it shows the child the path goes through (its `active`, else its first child). A layout without
 * the block says null (unknown): the caller treats that as shown.
 */
export function viewShown(tree, view) {
  const path = viewPath(tree, view);
  if (!path) return null;
  return path.every((n, i) => {
    if (n.hidden) return false;
    const next = path[i + 1];
    if (n.type !== "stack" || !next) return true;
    return (n.active ?? n.children?.[0]?.id) === next.id;
  });
}
