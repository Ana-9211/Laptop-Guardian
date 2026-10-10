'use strict';
/**
 * Process policy matching, the same rules as Processes/Policy.psm1 (Find-PolicyMatch, Add-PolicyEntry): names compare case-insensitively with
 * surrounding spaces and a trailing .exe ignored; paths compare case-insensitively (Windows paths); a path-scoped entry matches only that exact
 * path and never a name-only query; disabled entries and entries paused into the future do not match; precedence is whitelist, blacklist, ignored.
 * tests/fixtures/policy-match-cases.json is run through BOTH implementations, so they cannot drift apart.
 */
const procKey = (name) => String(name == null ? '' : name).trim().toLowerCase().replace(/\.exe$/, '');
const lowerPath = (p) => String(p == null ? '' : p).toLowerCase();

function isActive(e, now = Date.now()) {
  if (e && e.enabled === false) return false;
  if (e && e.disabledUntil) { const t = Date.parse(e.disabledUntil); if (!Number.isNaN(t) && t > now) return false; }
  return true;
}

/** { list, entry } for a running process, or { list: 'none', entry: null }. */
function findPolicyMatch(policy, name, procPath, now = Date.now()) {
  const k = procKey(name);
  for (const list of ['whitelist', 'blacklist', 'ignored']) {
    for (const e of (policy && policy[list]) || []) {
      if (procKey(e.name) !== k) continue;
      if (e.path && (!procPath || lowerPath(e.path) !== lowerPath(procPath))) continue;   // path-scoped: exact path only
      if (!isActive(e, now)) continue;
      return { list, entry: e };
    }
  }
  return { list: 'none', entry: null };
}

/** The entry that an "add" would duplicate: same name and the same scope (both without a path, or the same path). */
const sameScope = (e, name, scopePath) => procKey(e.name) === procKey(name) && lowerPath(e.path) === lowerPath(scopePath);

/** Entries on the OPPOSITE list that a move to this list replaces: same name, and either side unscoped or the same path. */
const overlapsForMove = (e, name, scopePath) => procKey(e.name) === procKey(name) && (!e.path || !scopePath || lowerPath(e.path) === lowerPath(scopePath));

module.exports = { procKey, isActive, findPolicyMatch, sameScope, overlapsForMove };
