/**
 * Ingestion operating mode (2026-09-08).
 *
 *   historical — the backfill runner is reinforcing the store with old
 *                articles; the scheduled cron pauses so the two do not compete
 *                and spend stays with the backfill.
 *   current    — the cron gathers new articles to keep the store current.
 *
 * The runner sets "historical" when it starts and "current" once it has
 * completed the agreed number of good runs. Absent a row, the mode is current.
 */
import { prisma } from "@/lib/db";

export type IngestionMode = "historical" | "current";
const KEY = "ingestion.mode";

export async function getIngestionMode(): Promise<{ mode: IngestionMode; note: string | null; since: Date | null }> {
  const row = await prisma.systemSetting.findUnique({ where: { key: KEY } }).catch(() => null);
  if (!row) return { mode: "current", note: null, since: null };
  try {
    const v = JSON.parse(row.value) as { mode?: IngestionMode; note?: string };
    return { mode: v.mode === "historical" ? "historical" : "current", note: v.note ?? null, since: row.updatedAt };
  } catch { return { mode: "current", note: null, since: row.updatedAt }; }
}

export async function setIngestionMode(mode: IngestionMode, note: string): Promise<void> {
  const value = JSON.stringify({ mode, note });
  await prisma.systemSetting.upsert({ where: { key: KEY }, update: { value }, create: { key: KEY, value } });
}
