import { signOut } from "@/lib/auth/actions";

// Placeholder until phase 5 builds the real Platform console.
export default function PlatformIndexPage() {
  return (
    <div style={{ maxWidth: 480, margin: "80px auto", fontFamily: "sans-serif" }}>
      <h1>Platform</h1>
      <p>Signed in as platform operator. The real console lands in a later phase.</p>
      <form action={signOut}>
        <button type="submit">Sign out</button>
      </form>
    </div>
  );
}
