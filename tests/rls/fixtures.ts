import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/admin";

export type SeededClub = {
  clubId: string;
  slug: string;
  adminEmail: string;
  adminPassword: string;
  adminUserId: string;
  memberId: string;
  productId: string;
  inventoryMoveId: string;
  donationId: string;
  contractTemplateId: string;
  signedContractId: string;
  signaturePath: string;
};

export type SeededData = {
  clubA: SeededClub;
  clubB: SeededClub;
  platformEmail: string;
  platformPassword: string;
  platformUserId: string;
};

const PASSWORD = "Test-Password-123!";

// A minimal valid 1x1 PNG — content doesn't matter, only that Storage
// accepts the upload so RLS on the object can be exercised.
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

async function seedClub(admin: SupabaseClient, label: string): Promise<SeededClub> {
  const suffix = crypto.randomUUID().slice(0, 8);
  const slug = `rls-test-${label}-${suffix}`;

  const { data: club, error: clubError } = await admin
    .from("clubs")
    .insert({
      slug,
      name: `RLS Test Club ${label} ${suffix}`,
      initials: label.toUpperCase(),
      plan: "Trial",
      region: "Test Region",
      accent_color: "#3f7a4e",
      status: "active",
    })
    .select()
    .single();
  if (clubError) throw clubError;

  const adminEmail = `rls-admin-${label}-${suffix}@example.test`;
  const { data: authUser, error: authError } = await admin.auth.admin.createUser({
    email: adminEmail,
    password: PASSWORD,
    email_confirm: true,
  });
  if (authError) throw authError;

  const { error: membershipError } = await admin.from("club_users").insert({
    club_id: club.id,
    user_id: authUser.user.id,
    role: "admin",
  });
  if (membershipError) throw membershipError;

  const { data: member, error: memberError } = await admin
    .from("members")
    .insert({
      club_id: club.id,
      code: `${label.toUpperCase()}-0001`,
      first: "Test",
      last: "Member",
      type: "Full member",
      status: "active",
      token_balance: 100,
    })
    .select()
    .single();
  if (memberError) throw memberError;

  const { data: product, error: productError } = await admin
    .from("products")
    .insert({
      club_id: club.id,
      name: "Test Product",
      category: "Flower",
      unit: "per 1g",
      token_price: 45,
      sell_price: 60,
    })
    .select()
    .single();
  if (productError) throw productError;

  const { data: move, error: moveError } = await admin
    .from("inventory_moves")
    .insert({
      club_id: club.id,
      product_id: product.id,
      type: "PURCHASE",
      qty: 100,
    })
    .select()
    .single();
  if (moveError) throw moveError;

  const { data: donation, error: donationError } = await admin
    .from("donations")
    .insert({
      club_id: club.id,
      member_id: member.id,
      amount_rand: 300,
      method: "Cash",
      tokens_credited: 300,
    })
    .select()
    .single();
  if (donationError) throw donationError;

  const { data: template, error: templateError } = await admin
    .from("contract_templates")
    .insert({
      club_id: club.id,
      title: `${label.toUpperCase()} Member Agreement`,
      subtitle: "Test subtitle",
      consent: "Test consent",
      clauses: [{ heading: "Intro", body: "Test clause body" }],
    })
    .select()
    .single();
  if (templateError) throw templateError;

  const signaturePath = `${club.id}/${member.id}/sig-${suffix}.png`;
  const { error: uploadError } = await admin.storage
    .from("signatures")
    .upload(signaturePath, TINY_PNG, { contentType: "image/png" });
  if (uploadError) throw uploadError;

  const { data: signedContract, error: signedContractError } = await admin
    .from("signed_contracts")
    .insert({
      club_id: club.id,
      member_id: member.id,
      template_version: template.version,
      contract_snapshot: {
        title: template.title,
        subtitle: template.subtitle,
        consent: template.consent,
        clauses: template.clauses,
      },
      consent: true,
      printed_name: "Test Member",
      signature_url: signaturePath,
    })
    .select()
    .single();
  if (signedContractError) throw signedContractError;

  return {
    clubId: club.id,
    slug,
    adminEmail,
    adminPassword: PASSWORD,
    adminUserId: authUser.user.id,
    memberId: member.id,
    productId: product.id,
    inventoryMoveId: move.id,
    donationId: donation.id,
    contractTemplateId: template.id,
    signedContractId: signedContract.id,
    signaturePath,
  };
}

export async function seedTenants(): Promise<SeededData> {
  const admin = createAdminClient();

  const clubA = await seedClub(admin, "a");
  const clubB = await seedClub(admin, "b");

  const suffix = crypto.randomUUID().slice(0, 8);
  const platformEmail = `rls-platform-${suffix}@example.test`;
  const { data: platformAuthUser, error: platformAuthError } = await admin.auth.admin.createUser({
    email: platformEmail,
    password: PASSWORD,
    email_confirm: true,
  });
  if (platformAuthError) throw platformAuthError;

  const { error: platformInsertError } = await admin
    .from("platform_users")
    .insert({ user_id: platformAuthUser.user.id });
  if (platformInsertError) throw platformInsertError;

  return {
    clubA,
    clubB,
    platformEmail,
    platformPassword: PASSWORD,
    platformUserId: platformAuthUser.user.id,
  };
}

export async function cleanupTenants(data: SeededData): Promise<void> {
  const admin = createAdminClient();

  await admin.storage
    .from("signatures")
    .remove([data.clubA.signaturePath, data.clubB.signaturePath]);
  // Deleting the clubs cascades to club_users, members, products,
  // inventory_moves, donations, contract_templates, signed_contracts —
  // every one of those FKs is `on delete cascade`.
  await admin.from("clubs").delete().in("id", [data.clubA.clubId, data.clubB.clubId]);
  await admin.auth.admin.deleteUser(data.clubA.adminUserId);
  await admin.auth.admin.deleteUser(data.clubB.adminUserId);
  await admin.auth.admin.deleteUser(data.platformUserId);
}

export async function signInAs(email: string, password: string): Promise<SupabaseClient> {
  const client = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  );
  const { error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return client;
}
