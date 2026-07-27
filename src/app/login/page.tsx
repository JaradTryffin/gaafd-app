import { login } from "./actions";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;

  return (
    <div style={{ maxWidth: 360, margin: "80px auto", fontFamily: "sans-serif" }}>
      <h1>Sign in</h1>
      {error && <p style={{ color: "#b4432f" }}>{error}</p>}
      <form action={login} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <div>
          <label htmlFor="email">Email</label>
          <br />
          <input id="email" name="email" type="email" required style={{ width: "100%" }} />
        </div>
        <div>
          <label htmlFor="password">Password</label>
          <br />
          <input
            id="password"
            name="password"
            type="password"
            required
            style={{ width: "100%" }}
          />
        </div>
        <button type="submit">Sign in</button>
      </form>
    </div>
  );
}
