import { EventsTable } from "@/components/market/EventsTable";

export default function EventsPage() {
  return (
    <div className="p-6 space-y-5 max-w-7xl">
      <div>
        <h1 className="text-xl font-semibold">Market Events</h1>
        <p className="text-sm text-muted-foreground mt-0.5">
          All publicly announced IT services market activity — contracts, M&amp;A, partnerships, org changes, and new offerings
        </p>
      </div>
      <EventsTable />
    </div>
  );
}
