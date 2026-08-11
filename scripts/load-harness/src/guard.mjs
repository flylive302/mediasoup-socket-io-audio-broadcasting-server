// Production refusal guard. This harness must NEVER touch production
// (ticket 34 AC: "no code path or config lets it point at production").
// Two independent locks: a hostname deny-list that cannot be configured away,
// and a positive allow handshake the operator must set per run.

const DENY_SUFFIXES = ['flyliveapp.com', 'flylive.app'];
const DENY_EXACT = ['flylive-audio-production-bom-02'];

export function assertSafeTarget(config) {
  const url = new URL(config.target.url);
  const host = url.hostname.toLowerCase();

  for (const suffix of DENY_SUFFIXES) {
    if (host === suffix || host.endsWith(`.${suffix}`)) {
      throw new Error(
        `REFUSED: target host "${host}" is a production domain (${suffix}). ` +
          'This harness never runs against production, at any ramp stage.'
      );
    }
  }
  if (DENY_EXACT.includes(host)) {
    throw new Error(`REFUSED: target host "${host}" is the production box.`);
  }

  if (config.target.environmentName !== 'load-test') {
    throw new Error(
      'REFUSED: config.target.environmentName must be exactly "load-test". ' +
        'This is a declaration that the target is the dedicated load-test environment.'
    );
  }

  // Positive handshake: the operator must export the target hostname explicitly.
  if (process.env.LOAD_HARNESS_ALLOW_TARGET !== host) {
    throw new Error(
      `REFUSED: export LOAD_HARNESS_ALLOW_TARGET=${host} to confirm this exact ` +
        'host is the dedicated load-test environment. No default, no wildcard.'
    );
  }
}
