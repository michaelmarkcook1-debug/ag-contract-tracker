import Link from "next/link";
import { ShieldAlert } from "lucide-react";

export default async function AdminSignIn({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;
  return (
    <section className="mx-auto max-w-md px-4 py-12 md:py-20">
      <div className="rounded-xl border border-border bg-card p-6 shadow-sm">
        <ShieldAlert className="mb-4 h-5 w-5 text-emerald-400" aria-hidden="true" />
        <h1 className="text-xl font-semibold tracking-tight">Admin sign-in</h1>
        <p className="mt-2 text-sm text-muted-foreground">Enter your existing admin password to manage ingestion and review events.</p>
        <form action="/api/admin/session" method="post" className="mt-6 space-y-4">
          <label htmlFor="admin-password" className="block text-sm font-medium">Admin password</label>
          <input id="admin-password" name="password" type="password" autoComplete="current-password" required maxLength={1024}
            className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus-visible:outline-2 focus-visible:outline-emerald-400" />
          {error === "1" && <p role="alert" className="text-sm text-red-400">That password was not accepted. Try again.</p>}
          <button type="submit" className="w-full rounded-md bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-500">
            Sign in
          </button>
        </form>
        <Link href="/events" className="mt-5 inline-block text-sm text-muted-foreground hover:text-foreground">Back to public Tracker</Link>
      </div>
    </section>
  );
}
