# Compliance Guardrails — Secure Distributor Link

## Non-negotiable rules (enforced)

- No credential-harvesting tool; no raw distributor password storage.
- No hosted credential form in any environment (`assertNoHostedCredentialForm`
  startup hard-block + tests); there is no development override.
- No bypassing/solving/automating CAPTCHA, 2FA, bot detection, paywalls, or access
  controls; no stealth/anti-bot/account-evasion techniques.
- No high-volume scraping or aggressive parallel automation (rate limit +
  concurrency=1 + stop-on-challenge).
- Prefer official/partner APIs, distributor exports, user CSV uploads, and
  user-attended browser sessions.
- Only accounts the user owns or is explicitly authorized to manage.
- Consent explicit, granular, auditable, revocable, time-limited.
- Cookies/localStorage/profiles/session handles/screenshots/exported catalog data
  are sensitive: encrypted at rest, ephemeral by default, never exposed to the
  frontend, never logged.
- Risky connector modes are feature-flagged **off** by default.

## Legal review checklist — before enabling a real provider in production

- [ ] Confirm the target distributor's ToS permits attended, user-authorized,
      low-volume automation of the account holder's own catalog data.
- [ ] Confirm no automated authentication / challenge-solving occurs.
- [ ] Confirm provider tokens are server-side only and encrypted.
- [ ] Confirm session/state TTLs, revocation, and deletion work end-to-end.
- [ ] Confirm screenshot redaction covers login/2FA/billing/payment/tax/settings.
- [ ] Confirm rate limits and full audit logging are active.
- [ ] Record the approver + date in the audit log before flipping the flag.
- [ ] Keep `ENABLE_HOSTED_CREDENTIAL_FORM=false`; use Steel as the only real
      browser/session provider. Keep Browserless, local Chromium/VNC, Hyperbeam,
      Kasm, and test-only fixtures out of production.
- [ ] Complete the evidence and approval record in
      [production-acceptance.md](production-acceptance.md).
