import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { resolveClubAccess } from "@/lib/auth/club-access";
import { getProducts } from "@/lib/products";
import { getMovements } from "@/lib/inventory";
import { InventoryHeader } from "./inventory-header";
import { InventoryTable } from "./inventory-table";

export default async function InventoryPage({
  params,
}: {
  params: Promise<{ clubSlug: string }>;
}) {
  const { clubSlug } = await params;
  const supabase = await createClient();
  const access = await resolveClubAccess(supabase, clubSlug);
  if (!access) notFound();

  const [products, movements] = await Promise.all([
    getProducts(supabase, access.clubId),
    getMovements(supabase, access.clubId),
  ]);

  return (
    <>
      <InventoryHeader />
      <InventoryTable clubId={access.clubId} products={products} movements={movements} />
    </>
  );
}
