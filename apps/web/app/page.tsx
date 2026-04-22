"use client";

import { SignInButton, useAuth } from "@clerk/nextjs";
import { ArrowRight, Radio } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import Dashboard from "./components/dashboard";

const SIGN_OUT_CONFIRMATION_MS = 12000;

type SessionGate = {
  hasOpenedDashboard: boolean;
  confirmedSignedOut: boolean;
};

export default function Home() {
  const { isLoaded, isSignedIn } = useAuth({
    treatPendingAsSignedOut: false,
  });
  const [sessionGate, setSessionGate] = useState<SessionGate>({
    hasOpenedDashboard: false,
    confirmedSignedOut: false,
  });
  const signOutTimerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (signOutTimerRef.current) {
        window.clearTimeout(signOutTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!isLoaded) return;

    if (isSignedIn) {
      if (signOutTimerRef.current) {
        window.clearTimeout(signOutTimerRef.current);
        signOutTimerRef.current = null;
      }

      window.setTimeout(() => {
        setSessionGate({
          hasOpenedDashboard: true,
          confirmedSignedOut: false,
        });
      }, 0);
      return;
    }

    if (!sessionGate.hasOpenedDashboard) {
      window.setTimeout(() => {
        setSessionGate((current) => {
          if (current.hasOpenedDashboard) return current;
          return {
            ...current,
            confirmedSignedOut: true,
          };
        });
      }, 0);
      return;
    }

    if (signOutTimerRef.current) return;

    signOutTimerRef.current = window.setTimeout(() => {
      signOutTimerRef.current = null;
      setSessionGate((current) => ({
        ...current,
        confirmedSignedOut: true,
      }));
    }, SIGN_OUT_CONFIRMATION_MS);
  }, [isLoaded, isSignedIn, sessionGate.hasOpenedDashboard]);

  if (!isLoaded && !sessionGate.hasOpenedDashboard) {
    return <LoadingScreen />;
  }

  if (
    isSignedIn ||
    (sessionGate.hasOpenedDashboard && !sessionGate.confirmedSignedOut)
  ) {
    return (
      <>
        <Dashboard />
        {!isSignedIn ? <SessionCheckNotice /> : null}
      </>
    );
  }

  return <SignInScreen />;
}

function LoadingScreen() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-[#020205] text-white">
      <div className="text-xs font-semibold uppercase tracking-[0.28em] text-white/50">
        Loading AirGuard
      </div>
    </main>
  );
}

function SessionCheckNotice() {
  return (
    <div className="fixed bottom-5 left-1/2 z-[1000] -translate-x-1/2 rounded-full border border-amber-300/25 bg-black/75 px-4 py-2 text-xs font-semibold uppercase tracking-[0.18em] text-amber-100 shadow-[0_0_40px_rgba(251,191,36,0.16)] backdrop-blur">
      Checking session
    </div>
  );
}

function SignInScreen() {
  return (
    <main className="relative flex min-h-screen items-center justify-center overflow-hidden bg-[#020205] px-6 text-white">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_50%_30%,rgba(206,68,255,0.28),transparent_30%),linear-gradient(180deg,rgba(255,255,255,0.05),transparent_42%)]" />
      <div className="pointer-events-none absolute inset-0 starfield opacity-70" />

      <section className="relative z-10 mx-auto flex max-w-3xl flex-col items-center text-center">
        <div className="mb-10 flex h-24 w-24 items-center justify-center rounded-full border border-fuchsia-300/30 bg-fuchsia-300/10 shadow-[0_0_80px_rgba(217,70,239,0.62)]">
          <Radio className="h-10 w-10 text-fuchsia-100" />
        </div>
        <p className="text-xs font-semibold uppercase tracking-[0.52em] text-white/45">
          AirGuard
        </p>
        <h1 className="mt-5 text-4xl font-light tracking-[0.34em] text-white sm:text-6xl">
          LIVE AIR INTELLIGENCE
        </h1>
        <p className="mt-6 max-w-2xl text-base leading-8 text-white/55 sm:text-lg">
          Follow monitoring stations, set pollutant thresholds, and watch
          realtime air quality updates flow from OpenAQ through Supabase.
        </p>
        <div className="mt-10">
          <SignInButton mode="modal">
            <button className="flex h-12 items-center gap-3 rounded-full bg-fuchsia-400 px-7 text-xs font-bold uppercase tracking-[0.24em] text-white shadow-[0_0_40px_rgba(217,70,239,0.42)] transition hover:bg-fuchsia-300">
              Sign In
              <ArrowRight className="h-4 w-4" />
            </button>
          </SignInButton>
        </div>
      </section>
    </main>
  );
}
