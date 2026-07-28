"use client";

import { useState } from "react";
import { useFormStatus } from "react-dom";
import { login } from "./actions";

function SubmitButton({ ready }: { ready: boolean }) {
  const { pending } = useFormStatus();
  const disabled = !ready || pending;
  return (
    <button
      type="submit"
      disabled={disabled}
      className="mt-1 w-full rounded-[9px] py-3 text-[14px] font-semibold text-white disabled:cursor-not-allowed disabled:bg-[#e4e1d7] disabled:text-[#a29c8c]"
      style={!disabled ? { background: "var(--primary)" } : undefined}
    >
      {pending ? "Signing in…" : "Sign in"}
    </button>
  );
}

export function LoginForm({ error }: { error?: string }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(true);

  const ready = /.+@.+\..+/.test(email) && password.length > 0;

  return (
    <div className="w-full max-w-[380px]">
      <div className="font-heading text-2xl font-semibold tracking-[-0.02em]">Sign in</div>
      <p className="mt-1.5 text-[13.5px] text-muted-foreground">
        Welcome back. Enter your details to continue.
      </p>

      <form action={login} className="mt-7 flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <label
            htmlFor="email"
            className="text-[11px] font-semibold uppercase tracking-[.04em] text-muted-foreground"
          >
            Email
          </label>
          <input
            id="email"
            name="email"
            type="email"
            required
            autoComplete="email"
            placeholder="you@club.co.za"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="w-full rounded-[9px] border border-input bg-card px-[13px] py-[11px] text-[14px] text-foreground outline-none focus:border-[#3f7a4e] focus:ring-[3px] focus:ring-[rgba(63,122,78,.12)]"
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <div className="flex items-baseline justify-between">
            <label
              htmlFor="password"
              className="text-[11px] font-semibold uppercase tracking-[.04em] text-muted-foreground"
            >
              Password
            </label>
            <a
              href="#"
              onClick={(e) => e.preventDefault()}
              className="text-[11.5px] text-[#3f7a4e] hover:text-[#2f5d3a]"
            >
              Forgot?
            </a>
          </div>
          <input
            id="password"
            name="password"
            type="password"
            required
            autoComplete="current-password"
            placeholder="••••••••"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full rounded-[9px] border border-input bg-card px-[13px] py-[11px] text-[14px] text-foreground outline-none focus:border-[#3f7a4e] focus:ring-[3px] focus:ring-[rgba(63,122,78,.12)]"
          />
        </div>

        <label className="flex cursor-pointer select-none items-center gap-2.5 text-[13px] text-[#4a4e45]">
          <input
            type="checkbox"
            checked={remember}
            onChange={(e) => setRemember(e.target.checked)}
            className="h-4 w-4 cursor-pointer accent-primary"
          />
          Keep me signed in
        </label>

        {error && (
          <div className="flex items-center gap-2 rounded-[9px] border border-[#eecfc7] bg-[#faece8] px-3 py-2.5 text-[12.5px] text-destructive">
            <span className="font-bold">!</span>
            {error}
          </div>
        )}

        <SubmitButton ready={ready} />
      </form>

      <div className="mt-[22px] border-t border-border pt-[18px] text-[12.5px] text-muted-foreground">
        Access is invite-only. Need an account? Ask your club admin to send an invite, or{" "}
        <a
          href="#"
          onClick={(e) => e.preventDefault()}
          className="text-[#3f7a4e] hover:text-[#2f5d3a]"
        >
          contact the GaafD team
        </a>
        .
      </div>
    </div>
  );
}
