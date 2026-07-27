import { signOut } from "@/lib/auth/actions";

// Shouldn't normally be reachable — invites always create a club_users row
// atomically — but handled rather than left to crash.
export default function NoAccessPage() {
  return (
    <div style={{ maxWidth: 480, margin: "80px auto", fontFamily: "sans-serif" }}>
      <h1>No access yet</h1>
      <p>Your account isn&apos;t linked to any club. Contact your club admin.</p>
      <form action={signOut}>
        <button type="submit">Sign out</button>
      </form>
    </div>
  );
}
