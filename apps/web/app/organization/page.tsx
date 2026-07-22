import { OrganizationManager } from './OrganizationManager';

export const metadata = {
  title: 'Organization access — Catalog Sentinel',
  description: 'Manage organization members, workspace access, and verified-email invitations.',
};

export default function OrganizationPage() {
  return (
    <>
      <div className="eyebrow">Access control</div>
      <h1 className="page-title">Organization &amp; workspaces</h1>
      <p className="page-sub">
        Review who can access each artist workspace, issue expiring invitations, and remove access.
        Initial owner and workspace provisioning remain restricted to the trusted control plane.
      </p>
      <OrganizationManager />
    </>
  );
}
