import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { resolveClubAccess } from "@/lib/auth/club-access";
import { getProducts } from "@/lib/products";
import { ProductsHeader } from "./products-header";
import { ProductsTable } from "./products-table";

export default async function ProductsPage({
  params,
}: {
  params: Promise<{ clubSlug: string }>;
}) {
  const { clubSlug } = await params;
  const supabase = await createClient();
  const access = await resolveClubAccess(supabase, clubSlug);
  if (!access) notFound();
  if (access.role !== "admin") notFound();

  const products = await getProducts(supabase, access.clubId);

  return (
    <>
      <ProductsHeader clubName={access.name} count={products.length} />
      <ProductsTable clubId={access.clubId} products={products} />
    </>
  );
}
