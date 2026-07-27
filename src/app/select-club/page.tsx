import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

export default async function SelectClubPage() {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    redirect("/login");
  }

  const { data: memberships } = await supabase
    .from("club_users")
    .select("club_id")
    .eq("user_id", user.id);
  const clubIds = (memberships ?? []).map((m) => m.club_id);

  // .in() with an empty array can behave oddly in PostgREST — fall back to
  // a placeholder id that can never match a real row rather than passing [].
  const { data: clubs } = await supabase
    .from("clubs")
    .select("slug, name")
    .in("id", clubIds.length > 0 ? clubIds : ["00000000-0000-0000-0000-000000000000"]);

  return (
    <div style={{ maxWidth: 480, margin: "80px auto", fontFamily: "sans-serif" }}>
      <h1>Select a club</h1>
      <ul>
        {(clubs ?? []).map((c) => (
          <li key={c.slug}>
            <a href={`/${c.slug}`}>{c.name}</a>
          </li>
        ))}
      </ul>
    </div>
  );
}
