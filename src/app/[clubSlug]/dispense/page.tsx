import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { resolveClubAccess } from "@/lib/auth/club-access";
import { getProducts } from "@/lib/products";
import { getCategories } from "@/lib/categories";
import { listMembers } from "@/lib/members";
import { DispensingHeader } from "./dispensing-header";
import { DispensingPanel } from "./dispensing-panel";

export default async function DispensePage({
  params,
}: {
  params: Promise<{ clubSlug: string }>;
}) {
  const { clubSlug } = await params;
  const supabase = await createClient();
  const access = await resolveClubAccess(supabase, clubSlug);
  if (!access) notFound();

  const [products, members, categories] = await Promise.all([
    getProducts(supabase, access.clubId),
    listMembers(supabase, access.clubId),
    getCategories(supabase, access.clubId),
  ]);

  return (
    <>
      <DispensingHeader />
      <DispensingPanel clubId={access.clubId} products={products} members={members} categories={categories} />
    </>
  );
}
