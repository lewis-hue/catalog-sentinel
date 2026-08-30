import { ProfileClient } from './ProfileClient';

/** Profile / account settings. Identity + a link to the Keycloak account console for edits;
 *  self-service account deletion lives in the client component's danger zone. */
export default function ProfilePage() {
  const base = (process.env.KEYCLOAK_PUBLIC_BASE_URL || process.env.KEYCLOAK_BASE_URL || '').replace(/\/+$/, '');
  const realm = process.env.KEYCLOAK_REALM || 'sentinel';
  const accountConsoleUrl = base ? `${base}/realms/${encodeURIComponent(realm)}/account/` : '#';
  return <ProfileClient accountConsoleUrl={accountConsoleUrl} />;
}
