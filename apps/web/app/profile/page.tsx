import { ProfileClient } from './ProfileClient';

/** Profile / account settings. Identity overview, in-app username editing (email is read-only),
 *  and a confirmed, irreversible account-deletion danger zone in the client component. */
export default function ProfilePage() {
  return <ProfileClient />;
}
