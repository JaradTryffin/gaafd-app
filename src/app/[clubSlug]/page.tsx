"use client";

import { useClub } from "@/lib/club-context";
import { signOut } from "@/lib/auth/actions";

// Placeholder until phase 3 (app shell) and phase 5 (real Dashboard
// screen) land. Proves auth + club resolution + context work end to end.
export default function ClubIndexPage() {
  const club = useClub();
  return (
    <div style={{ maxWidth: 480, margin: "80px auto", fontFamily: "sans-serif" }}>
      <h1>{club.name}</h1>
      <p>Signed in as {club.role}. The real dashboard lands in a later phase.</p>
      <form action={signOut}>
        <button type="submit">Sign out</button>
      </form>
    </div>
  );
}
