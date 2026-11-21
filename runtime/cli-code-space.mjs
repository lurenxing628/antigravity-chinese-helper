const branchRange = 128 * 1024 * 1024;

function canBranch(from, to) {
  const delta = to - from;
  return Number.isSafeInteger(delta) && delta % 4 === 0 && delta >= -branchRange && delta < branchRange;
}

// Routines share the reserved UI area and their final order depends on which
// roles this build supports. Check both ends, including the return path.
export function cliSiteReachesCodeSpace(imageBase, site, {codeAddress, capacity}) {
  if (capacity < 4 || capacity % 4 !== 0) return false;
  const last = codeAddress + capacity - 4;
  const start = imageBase + site.rva;
  const resume = imageBase + (site.resumeRva ?? site.callRva ?? site.rva + 4);
  return canBranch(start, codeAddress) && canBranch(start, last) &&
    canBranch(codeAddress, resume) && canBranch(last, resume) &&
    (site.callRva === undefined || canBranch(imageBase + site.callRva, site.targetAddress));
}

/** Retain the independently reachable UI consumers of the shared lookup. */
export function partitionCliDisplaySites(plan, space) {
  const sites = [], skippedSites = [];
  for (const site of plan.sites ?? [plan.site]) {
    if (cliSiteReachesCodeSpace(plan.imageBase, site, space)) { sites.push(site); continue; }
    // The UI collector only supplies wideEntry for a three-instruction
    // rendering sequence that can be replayed before the first branch.
    const page = Math.floor((plan.imageBase + site.rva) / 4096);
    const first = Math.floor(space.codeAddress / 4096), end = Math.floor((space.codeAddress + space.capacity) / 4096);
    if (site.wideEntry?.length === 12 && space.capacity >= 12 &&
        first > page - 0x100000 && end < page + 0x100000) sites.push({...site, wide:true});
    else skippedSites.push(site);
  }
  if (!skippedSites.length && !sites.some(site => site.wide)) return {plan, skippedSites};
  return {plan:{...plan, ...(plan.site && {site:sites[0]}), sites}, skippedSites};
}
