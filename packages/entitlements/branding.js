/** Customer-facing visual attribution only; custom domains are not provided. */
export function whiteLabelFor(org) {
 if (!['growth','scale','business'].includes(org?.plan)) return false;
 if (['crypto','stripe','platform_manual_override'].includes(org.planChangeSource) && org.planExpiresAt && Date.parse(org.planExpiresAt) <= Date.now()) return false;
 return true;
}
