import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { seedTenants, cleanupTenants, signInAs, type SeededData } from "./rls/fixtures";
import { createAdminClient } from "@/lib/supabase/admin";
import { registerMember } from "@/lib/members";
import { signContract, getOrCreateContractTemplate } from "@/lib/contracts";

// A minimal valid 1x1 PNG data URL, same fixture used by tests/rls/fixtures.ts.
const TINY_PNG_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

const TINY_PNG_BYTES = Buffer.from(
  TINY_PNG_DATA_URL.replace(/^data:image\/png;base64,/, ""),
  "base64",
);

let data: SeededData;
let clubAClient: SupabaseClient;
let clubBClient: SupabaseClient;
const cleanupMemberIds: string[] = [];
const cleanupSignaturePaths: string[] = [];
const cleanupIdPhotoPaths: string[] = [];

beforeAll(async () => {
  data = await seedTenants();
  clubAClient = await signInAs(data.clubA.adminEmail, data.clubA.adminPassword);
  clubBClient = await signInAs(data.clubB.adminEmail, data.clubB.adminPassword);
}, 30000);

afterAll(async () => {
  const admin = createAdminClient();
  if (cleanupSignaturePaths.length > 0) {
    await admin.storage.from("signatures").remove(cleanupSignaturePaths);
  }
  if (cleanupIdPhotoPaths.length > 0) {
    await admin.storage.from("member-ids").remove(cleanupIdPhotoPaths);
  }
  for (const memberId of cleanupMemberIds) {
    await admin.from("members").delete().eq("id", memberId);
  }
  if (data) {
    await cleanupTenants(data);
  }
}, 30000);

describe("registerMember", () => {
  it("generates a code following the club's initials", async () => {
    const { memberId, code } = await registerMember(clubAClient, {
      clubId: data.clubA.clubId,
      first: "Test",
      last: "One",
      type: "Full member",
    });
    cleanupMemberIds.push(memberId);
    // Format is {club initials}-{4-digit sequence}; the fixture club's
    // initials are uppercase letters, so this is a real, meaningful check
    // of the generated shape, not just "some string came back".
    expect(code).toMatch(/^[A-Z]+-\d{4}$/);
  });

  it("generates sequential codes for successive registrations", async () => {
    const first = await registerMember(clubAClient, {
      clubId: data.clubA.clubId,
      first: "Seq",
      last: "One",
      type: "Trial",
    });
    cleanupMemberIds.push(first.memberId);
    const second = await registerMember(clubAClient, {
      clubId: data.clubA.clubId,
      first: "Seq",
      last: "Two",
      type: "Trial",
    });
    cleanupMemberIds.push(second.memberId);

    const firstSeq = Number(first.code.split("-")[1]);
    const secondSeq = Number(second.code.split("-")[1]);
    expect(secondSeq).toBe(firstSeq + 1);
  });
});

describe("signContract", () => {
  it("uploads a signature and creates a signed_contracts row matching the current template", async () => {
    const { memberId } = await registerMember(clubAClient, {
      clubId: data.clubA.clubId,
      first: "Signer",
      last: "Test",
      type: "Full member",
    });
    cleanupMemberIds.push(memberId);

    const template = await getOrCreateContractTemplate(
      clubAClient,
      data.clubA.clubId,
      "Test Club A",
    );

    const { signedContractId } = await signContract(clubAClient, {
      clubId: data.clubA.clubId,
      memberId,
      printedName: "Signer Test",
      consent: true,
      signaturePngBase64: TINY_PNG_DATA_URL,
      template: {
        title: template.title,
        subtitle: template.subtitle,
        consent: template.consent,
        clauses: template.clauses,
        version: template.version,
      },
    });
    cleanupSignaturePaths.push(`${data.clubA.clubId}/${memberId}/${signedContractId}.png`);

    const admin = createAdminClient();
    const { data: row } = await admin
      .from("signed_contracts")
      .select("contract_snapshot, template_version, consent, printed_name")
      .eq("id", signedContractId)
      .single();
    expect(row?.template_version).toBe(template.version);
    expect(row?.consent).toBe(true);
    expect(row?.printed_name).toBe("Signer Test");
    expect((row?.contract_snapshot as { title: string }).title).toBe(template.title);
  });

  it("rejects when consent is false", async () => {
    const { memberId } = await registerMember(clubAClient, {
      clubId: data.clubA.clubId,
      first: "NoConsent",
      last: "Test",
      type: "Full member",
    });
    cleanupMemberIds.push(memberId);

    const template = await getOrCreateContractTemplate(clubAClient, data.clubA.clubId, "Test Club A");

    await expect(
      signContract(clubAClient, {
        clubId: data.clubA.clubId,
        memberId,
        printedName: "",
        consent: false,
        signaturePngBase64: TINY_PNG_DATA_URL,
        template: {
          title: template.title,
          subtitle: template.subtitle,
          consent: template.consent,
          clauses: template.clauses,
          version: template.version,
        },
      }),
    ).rejects.toThrow();
  });

  it("rejects when the member belongs to a different club than the one passed in", async () => {
    const { memberId: clubBMemberId } = await registerMember(clubBClient, {
      clubId: data.clubB.clubId,
      first: "WrongClub",
      last: "Test",
      type: "Full member",
    });
    cleanupMemberIds.push(clubBMemberId);

    const template = await getOrCreateContractTemplate(clubAClient, data.clubA.clubId, "Test Club A");

    await expect(
      signContract(clubAClient, {
        clubId: data.clubA.clubId,
        memberId: clubBMemberId,
        printedName: "",
        consent: true,
        signaturePngBase64: TINY_PNG_DATA_URL,
        template: {
          title: template.title,
          subtitle: template.subtitle,
          consent: template.consent,
          clauses: template.clauses,
          version: template.version,
        },
      }),
    ).rejects.toThrow("Member not found in this club");
  });
});

describe("registerMember with ID photos", () => {
  it("uploads both ID photos and saves their paths when provided", async () => {
    const idFront = new File([TINY_PNG_BYTES], "front.png", { type: "image/png" });
    const idBack = new File([TINY_PNG_BYTES], "back.png", { type: "image/png" });

    const { memberId } = await registerMember(clubAClient, {
      clubId: data.clubA.clubId,
      first: "Photo",
      last: "Both",
      type: "Full member",
      idFront,
      idBack,
    });
    cleanupMemberIds.push(memberId);
    const frontPath = `${data.clubA.clubId}/${memberId}/front`;
    const backPath = `${data.clubA.clubId}/${memberId}/back`;
    cleanupIdPhotoPaths.push(frontPath, backPath);

    const admin = createAdminClient();
    const { data: row } = await admin
      .from("members")
      .select("id_front_url, id_back_url")
      .eq("id", memberId)
      .single();
    expect(row?.id_front_url).toBe(frontPath);
    expect(row?.id_back_url).toBe(backPath);

    const { data: downloaded, error: downloadError } = await admin.storage
      .from("member-ids")
      .download(frontPath);
    expect(downloadError).toBeNull();
    expect(downloaded).not.toBeNull();
  });

  it("leaves both columns null and still succeeds when no photos are provided", async () => {
    const { memberId } = await registerMember(clubAClient, {
      clubId: data.clubA.clubId,
      first: "Photo",
      last: "None",
      type: "Trial",
    });
    cleanupMemberIds.push(memberId);

    const admin = createAdminClient();
    const { data: row } = await admin
      .from("members")
      .select("id_front_url, id_back_url")
      .eq("id", memberId)
      .single();
    expect(row?.id_front_url).toBeNull();
    expect(row?.id_back_url).toBeNull();
  });

  it("does not let club B read a photo stored under club A's folder", async () => {
    const idFront = new File([TINY_PNG_BYTES], "front.png", { type: "image/png" });
    const { memberId } = await registerMember(clubAClient, {
      clubId: data.clubA.clubId,
      first: "Photo",
      last: "Isolation",
      type: "Trial",
      idFront,
    });
    cleanupMemberIds.push(memberId);
    const path = `${data.clubA.clubId}/${memberId}/front`;
    cleanupIdPhotoPaths.push(path);

    // Positive baseline first: club A's own client can read it — so the
    // negative check below is a real RLS denial, not an unrelated failure
    // (wrong bucket name, auth issue) masquerading as one.
    const { error: sameClubError } = await clubAClient.storage.from("member-ids").download(path);
    expect(sameClubError).toBeNull();

    const { error } = await clubBClient.storage.from("member-ids").download(path);
    expect(error).not.toBeNull();
  });
});
