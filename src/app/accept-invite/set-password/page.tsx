import { setPassword } from "./actions";

export default async function SetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;

  return (
    <div style={{ maxWidth: 360, margin: "80px auto", fontFamily: "sans-serif" }}>
      <h1>Set your password</h1>
      {error && <p style={{ color: "#b4432f" }}>{error}</p>}
      <form action={setPassword} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <div>
          <label htmlFor="password">New password</label>
          <br />
          <input
            id="password"
            name="password"
            type="password"
            required
            minLength={6}
            style={{ width: "100%" }}
          />
        </div>
        <button type="submit">Set password and continue</button>
      </form>
    </div>
  );
}
