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

/**
 * A copy's view and the mode it starts in, from its props.view. A panel copy (the layout has a
 * Wingman block for that view) shows that one view. A Wingman tab or pane opened with props.view
 * "review" or "edit" outside such a layout starts there as a pane copy: it switches between Review
 * and Edit itself, so the comments and checkpoints dialogs' jumps (CMT_JUMP) land in it. "changes"
 * stays the Changes view.
 */
export function copyView(propsView, tree) {
  if (!["review", "edit", "changes"].includes(propsView)) return { view: null, mode: "review" };
  if (propsView === "changes" || viewPath(tree, propsView)) return { view: propsView, mode: propsView };
  return { view: null, mode: propsView };
}

/** Whether the layout has any Wingman block (a panel copy, whatever its view). */
export function layoutHasWingman(tree) {
  const walk = (n) => !!n && typeof n === "object" && (n.content?.mod === "wingman" || (n.children ?? []).some(walk));
  return walk(tree);
}

/**
 * The spaces Wingman reviews. With a Wingman block in the layout every space is reviewed (the panel
 * is shown beside whichever space is active, and its blocks are not in panes()). Without one, only
 * the spaces holding a Wingman pane in one of their tabs.
 */
export function reviewedSpaces(spaces, panes, inLayout) {
  if (inLayout) return spaces;
  const tabs = new Set(panes.filter((p) => p.mod === "wingman").map((p) => p.tab));
  return spaces.filter((s) => s.tabs.some((t) => tabs.has(t.id)));
}
