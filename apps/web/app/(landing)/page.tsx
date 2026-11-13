import { cookies } from "next/headers";
import { redirect } from "next/navigation";

/**
 * The root path is an entry redirect, not a destination: this instance has
 * no public marketing site, so unauthenticated visitors go to /login and
 * authenticated users go straight to their last workspace.
 *
 * The Next.js proxy (proxy.ts) already performs the same redirect for the
 * session + last-workspace-cookie case before a route renders — this page
 * covers what falls through it: no session, or a session without a
 * last-workspace cookie yet (first login). /login resolves an already
 * authenticated visitor against their workspace list (pending invitations,
 * zero-workspace state) and replaces to the right destination.
 */
export default async function RootRedirectPage() {
  const cookieStore = await cookies();
  const hasSession = cookieStore.has("multica_logged_in");
  const lastSlug = cookieStore.get("last_workspace_slug")?.value;

  if (hasSession && lastSlug) {
    redirect(`/${lastSlug}/issues`);
  }
  redirect("/login");
}
