-- Restore a nonempty integrity guard on the consent-revocation outbox.
--
-- 20260722150000_consent_revocation_intents created "ConsentRevocationIntent" with a CHECK that its
-- "artistWorkspaceId" was nonempty. 20260830000000_per_user_isolation removed the workspace concept
-- with `ALTER TABLE "ConsentRevocationIntent" DROP COLUMN "artistWorkspaceId"` and -- because
-- PostgreSQL drops any constraint that depends on a dropped column -- silently removed the table's
-- only integrity guard, leaving no backstop against a malformed outbox row. The consent id is now
-- the outbox's natural key; an intent that references an empty consent id is garbage, so guard it.
--
-- revokeConsentAndCreateIntent writes the consent revoke (a JSON UPDATE) and this INSERT as ONE SQL
-- statement, so the CHECK also makes that write atomic: a malformed intent rejects the INSERT and
-- rolls the preceding revoke back with it, which the durable-link integration test asserts.
ALTER TABLE "ConsentRevocationIntent"
  ADD CONSTRAINT "ConsentRevocationIntent_consentId_nonempty" CHECK ("consentId" <> '');
