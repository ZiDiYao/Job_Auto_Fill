export const PRIVACY_CONSENT_KEY = "jobAutofillPrivacyConsent";
export const PRIVACY_CONSENT_VERSION = 1;

export function normalizePrivacyConsent(value = {}) {
  return {
    version: Number(value.version || 0),
    acceptedAt: String(value.acceptedAt || ""),
    localProcessing: value.localProcessing === true,
    automaticPageAccess: value.automaticPageAccess === true,
    cloudAi: value.cloudAi === true,
    sensitiveAi: value.sensitiveAi === true,
    notion: value.notion === true,
  };
}

export function hasRequiredPrivacyConsent(value) {
  const consent = normalizePrivacyConsent(value);
  return consent.version === PRIVACY_CONSENT_VERSION && consent.localProcessing;
}

export function consentAllows(value, capability) {
  const consent = normalizePrivacyConsent(value);
  return hasRequiredPrivacyConsent(consent) && consent[capability] === true;
}
